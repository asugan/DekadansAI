import { config } from "../config";

import { database } from "./database";

interface RateLimitRow {
  userId: string;
  quotaWindowStartedAt: number;
  quotaRequestCount: number;
  burstWindowStartedAt: number;
  burstRequestCount: number;
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
}

export interface AccountRateLimitResult {
  allowed: boolean;
  reason?: "quota" | "burst";
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
      updatedAt integer not null
    )
  `
  )
  .run();

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
    updatedAt
  )
  values (@userId, @quotaWindowStartedAt, @quotaRequestCount, @burstWindowStartedAt, @burstRequestCount, @updatedAt)
  on conflict(userId) do update set
    quotaWindowStartedAt = excluded.quotaWindowStartedAt,
    quotaRequestCount = excluded.quotaRequestCount,
    burstWindowStartedAt = excluded.burstWindowStartedAt,
    burstRequestCount = excluded.burstRequestCount,
    updatedAt = excluded.updatedAt
`);

function normalizeRow(userId: string, now: number, row?: RateLimitRow): RateLimitRow {
  if (!row) {
    return {
      userId,
      quotaWindowStartedAt: now,
      quotaRequestCount: 0,
      burstWindowStartedAt: now,
      burstRequestCount: 0,
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
    updatedAt: now
  };
}

function buildSnapshot(row: RateLimitRow): AccountRateLimitSnapshot {
  return {
    quota: {
      windowMs: config.accountQuotaWindowMs,
      max: config.accountQuotaMax,
      used: Math.max(0, row.quotaRequestCount),
      remaining: Math.max(0, config.accountQuotaMax - row.quotaRequestCount),
      resetAt: new Date(row.quotaWindowStartedAt + config.accountQuotaWindowMs).toISOString()
    },
    burst: {
      windowMs: config.accountBurstWindowMs,
      max: config.accountBurstMax,
      used: Math.max(0, row.burstRequestCount),
      remaining: Math.max(0, config.accountBurstMax - row.burstRequestCount),
      resetAt: new Date(row.burstWindowStartedAt + config.accountBurstWindowMs).toISOString()
    }
  };
}

export function getAccountRateLimitSnapshot(userId: string, now = Date.now()): AccountRateLimitSnapshot {
  const row = normalizeRow(userId, now, getRow.get(userId) as RateLimitRow | undefined);
  upsertRow.run(row);
  return buildSnapshot(row);
}

export function consumeAccountRateLimit(userId: string, now = Date.now()): AccountRateLimitResult {
  const row = normalizeRow(userId, now, getRow.get(userId) as RateLimitRow | undefined);

  if (row.quotaRequestCount >= config.accountQuotaMax) {
    upsertRow.run(row);
    return {
      allowed: false,
      reason: "quota",
      retryAfterMs: Math.max(0, row.quotaWindowStartedAt + config.accountQuotaWindowMs - now),
      snapshot: buildSnapshot(row)
    };
  }

  if (row.burstRequestCount >= config.accountBurstMax) {
    upsertRow.run(row);
    return {
      allowed: false,
      reason: "burst",
      retryAfterMs: Math.max(0, row.burstWindowStartedAt + config.accountBurstWindowMs - now),
      snapshot: buildSnapshot(row)
    };
  }

  const updatedRow: RateLimitRow = {
    ...row,
    quotaRequestCount: row.quotaRequestCount + 1,
    burstRequestCount: row.burstRequestCount + 1,
    updatedAt: now
  };
  upsertRow.run(updatedRow);

  return {
    allowed: true,
    retryAfterMs: 0,
    snapshot: buildSnapshot(updatedRow)
  };
}
