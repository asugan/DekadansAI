import { config, type PlanTierConfig } from "../config";

import { database } from "./database";

interface RateLimitRow {
  userId: string;
  quotaWindowStartedAt: number;
  quotaRequestCount: number;
  burstWindowStartedAt: number;
  burstRequestCount: number;
  weeklyWindowStartedAt: number;
  weeklyRequestCount: number;
  updatedAt: number;
}

export interface AccountRateLimitSnapshot {
  quota: {
    windowMs: number;
    max: number;
    used: number;
    remaining: number;
    resetAt: string;
  };
  burst: {
    windowMs: number;
    max: number;
    used: number;
    remaining: number;
    resetAt: string;
  };
  weekly?: {
    windowMs: number;
    max: number;
    used: number;
    remaining: number;
    resetAt: string;
  };
}

export interface AccountRateLimitResult {
  allowed: boolean;
  reason?: "quota" | "burst" | "weekly";
  quotaCost: number;
  retryAfterMs: number;
  snapshot: AccountRateLimitSnapshot;
}

database
  .prepare(
    `
    create table if not exists account_rate_limit (
      userId text not null primary key references user(id) on delete cascade,
      quotaWindowStartedAt integer not null,
      quotaRequestCount integer not null,
      burstWindowStartedAt integer not null,
      burstRequestCount integer not null,
      weeklyWindowStartedAt integer not null default 0,
      weeklyRequestCount integer not null default 0,
      updatedAt integer not null
    )
  `
  )
  .run();

// Add weekly columns if missing (migration for existing rows)
try {
  database.prepare(`alter table account_rate_limit add column weeklyWindowStartedAt integer not null default 0`).run();
} catch { /* column already exists */ }
try {
  database.prepare(`alter table account_rate_limit add column weeklyRequestCount integer not null default 0`).run();
} catch { /* column already exists */ }

const getRow = database
  .prepare("select * from account_rate_limit where userId = ?")
  .pluck(false);
const upsertRow = database.prepare(`
  insert into account_rate_limit (
    userId,
    quotaWindowStartedAt,
    quotaRequestCount,
    burstWindowStartedAt,
    burstRequestCount,
    weeklyWindowStartedAt,
    weeklyRequestCount,
    updatedAt
  )
  values (@userId, @quotaWindowStartedAt, @quotaRequestCount, @burstWindowStartedAt, @burstRequestCount, @weeklyWindowStartedAt, @weeklyRequestCount, @updatedAt)
  on conflict(userId) do update set
    quotaWindowStartedAt = excluded.quotaWindowStartedAt,
    quotaRequestCount = excluded.quotaRequestCount,
    burstWindowStartedAt = excluded.burstWindowStartedAt,
    burstRequestCount = excluded.burstRequestCount,
    weeklyWindowStartedAt = excluded.weeklyWindowStartedAt,
    weeklyRequestCount = excluded.weeklyRequestCount,
    updatedAt = excluded.updatedAt
`);

function normalizeRow(userId: string, now: number, planTier: PlanTierConfig, row?: RateLimitRow): RateLimitRow {
  if (!row) {
    return {
      userId,
      quotaWindowStartedAt: now,
      quotaRequestCount: 0,
      burstWindowStartedAt: now,
      burstRequestCount: 0,
      weeklyWindowStartedAt: now,
      weeklyRequestCount: 0,
      updatedAt: now
    };
  }

  return {
    ...row,
    quotaWindowStartedAt:
      now - row.quotaWindowStartedAt >= config.accountQuotaWindowMs
        ? now
        : row.quotaWindowStartedAt,
    quotaRequestCount:
      now - row.quotaWindowStartedAt >= config.accountQuotaWindowMs ? 0 : row.quotaRequestCount,
    burstWindowStartedAt:
      now - row.burstWindowStartedAt >= config.accountBurstWindowMs
        ? now
        : row.burstWindowStartedAt,
    burstRequestCount:
      now - row.burstWindowStartedAt >= config.accountBurstWindowMs ? 0 : row.burstRequestCount,
    weeklyWindowStartedAt:
      now - (row.weeklyWindowStartedAt || 0) >= config.weeklyQuotaWindowMs
        ? now
        : (row.weeklyWindowStartedAt || now),
    weeklyRequestCount:
      now - (row.weeklyWindowStartedAt || 0) >= config.weeklyQuotaWindowMs ? 0 : (row.weeklyRequestCount || 0),
    updatedAt: now
  };
}

function buildSnapshot(row: RateLimitRow, planTier: PlanTierConfig): AccountRateLimitSnapshot {
  return {
    quota: {
      windowMs: config.accountQuotaWindowMs,
      max: planTier.quotaMax,
      used: Math.max(0, row.quotaRequestCount),
      remaining: Math.max(0, planTier.quotaMax - row.quotaRequestCount),
      resetAt: new Date(row.quotaWindowStartedAt + config.accountQuotaWindowMs).toISOString()
    },
    burst: {
      windowMs: config.accountBurstWindowMs,
      max: config.accountBurstMax,
      used: Math.max(0, row.burstRequestCount),
      remaining: Math.max(0, config.accountBurstMax - row.burstRequestCount),
      resetAt: new Date(row.burstWindowStartedAt + config.accountBurstWindowMs).toISOString()
    },
    weekly: {
      windowMs: config.weeklyQuotaWindowMs,
      max: planTier.weeklyQuotaMax,
      used: Math.max(0, row.weeklyRequestCount),
      remaining: Math.max(0, planTier.weeklyQuotaMax - row.weeklyRequestCount),
      resetAt: new Date((row.weeklyWindowStartedAt || 0) + config.weeklyQuotaWindowMs).toISOString()
    }
  };
}

const getAccountRateLimitSnapshotTx = database.transaction((
  userId: string,
  planTier: PlanTierConfig,
  now: number
): AccountRateLimitSnapshot => {
  const row = normalizeRow(userId, now, planTier, getRow.get(userId) as RateLimitRow | undefined);
  upsertRow.run(row);
  return buildSnapshot(row, planTier);
});

export function getAccountRateLimitSnapshot(
  userId: string,
  planTier: PlanTierConfig,
  now = Date.now()
): AccountRateLimitSnapshot {
  return getAccountRateLimitSnapshotTx(userId, planTier, now);
}

export function getModelRequestCost(model: string): number {
  return config.modelRequestCosts[model] || config.defaultModelRequestCost;
}

const consumeAccountRateLimitTx = database.transaction((
  userId: string,
  planTier: PlanTierConfig,
  quotaCost: number | undefined,
  now: number
): AccountRateLimitResult => {
  const safeQuotaCost = Math.max(1, Math.floor(quotaCost ?? config.defaultModelRequestCost));
  const row = normalizeRow(userId, now, planTier, getRow.get(userId) as RateLimitRow | undefined);

  // Check 5-hour quota
  if (row.quotaRequestCount + safeQuotaCost > planTier.quotaMax) {
    upsertRow.run(row);
    return {
      allowed: false,
      reason: "quota",
      quotaCost: safeQuotaCost,
      retryAfterMs: Math.max(0, row.quotaWindowStartedAt + config.accountQuotaWindowMs - now),
      snapshot: buildSnapshot(row, planTier)
    };
  }

  // Check burst
  if (row.burstRequestCount >= config.accountBurstMax) {
    upsertRow.run(row);
    return {
      allowed: false,
      reason: "burst",
      quotaCost: safeQuotaCost,
      retryAfterMs: Math.max(0, row.burstWindowStartedAt + config.accountBurstWindowMs - now),
      snapshot: buildSnapshot(row, planTier)
    };
  }

  // Check weekly quota
  if ((row.weeklyRequestCount || 0) + safeQuotaCost > planTier.weeklyQuotaMax) {
    upsertRow.run(row);
    return {
      allowed: false,
      reason: "weekly",
      quotaCost: safeQuotaCost,
      retryAfterMs: Math.max(0, (row.weeklyWindowStartedAt || 0) + config.weeklyQuotaWindowMs - now),
      snapshot: buildSnapshot(row, planTier)
    };
  }

  const updatedRow: RateLimitRow = {
    ...row,
    quotaRequestCount: row.quotaRequestCount + safeQuotaCost,
    burstRequestCount: row.burstRequestCount + 1,
    weeklyRequestCount: (row.weeklyRequestCount || 0) + safeQuotaCost,
    updatedAt: now
  };
  upsertRow.run(updatedRow);

  return {
    allowed: true,
    quotaCost: safeQuotaCost,
    retryAfterMs: 0,
    snapshot: buildSnapshot(updatedRow, planTier)
  };
});

export function consumeAccountRateLimit(
  userId: string,
  planTier: PlanTierConfig,
  quotaCost: number | undefined,
  now = Date.now()
): AccountRateLimitResult {
  return consumeAccountRateLimitTx(userId, planTier, quotaCost, now);
}
