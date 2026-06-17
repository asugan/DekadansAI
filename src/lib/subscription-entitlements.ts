import { createHash } from "node:crypto";

import { type PlanTierConfig, config } from "../config";

import { database } from "./database";
import { polarClient } from "./polar";
import { asObject, getActiveSubscriptions, isPolarNotFound, type WeeklyPlanStatus } from "./polar-state";

interface SubscriptionRow {
  polarSubscriptionId: string;
  userId: string;
  polarCustomerId: string | null;
  productId: string;
  tierSlug: string | null;
  status: string;
  currentPeriodEnd: number | null;
  canceledAt: number | null;
  cancelAtPeriodEnd: number;
  updatedAt: number;
}

interface SubscriptionCustomerRow {
  userId: string;
  polarCustomerId: string | null;
  customerExists: number;
  syncedAt: number;
}

export interface SubscriptionEntitlement extends WeeklyPlanStatus {
  source: "local" | "polar" | "none";
}

const inactiveStateTtlMs = 60_000;

database
  .prepare(
    `
    create table if not exists subscriptions (
      polarSubscriptionId text not null primary key,
      userId text not null references user(id) on delete cascade,
      polarCustomerId text,
      productId text not null,
      tierSlug text,
      status text not null,
      currentPeriodEnd integer,
      canceledAt integer,
      cancelAtPeriodEnd integer not null default 0,
      updatedAt integer not null
    )
  `
  )
  .run();

database
  .prepare("create index if not exists subscriptions_userId_idx on subscriptions(userId)")
  .run();

database
  .prepare(
    `
    create table if not exists subscription_customers (
      userId text not null primary key references user(id) on delete cascade,
      polarCustomerId text,
      customerExists integer not null,
      syncedAt integer not null
    )
  `
  )
  .run();

database
  .prepare(
    `
    create table if not exists webhook_events (
      eventId text not null primary key,
      eventType text not null,
      userId text,
      subscriptionId text,
      payloadHash text not null,
      processedAt integer not null
    )
  `
  )
  .run();

const getSubscriptionsByUser = database
  .prepare("select * from subscriptions where userId = ?")
  .pluck(false);

const getSubscriptionCustomerByUser = database
  .prepare("select * from subscription_customers where userId = ?")
  .pluck(false);

const listUserIds = database.prepare("select id from user").pluck();

const upsertSubscriptionCustomer = database.prepare(`
  insert into subscription_customers (
    userId,
    polarCustomerId,
    customerExists,
    syncedAt
  )
  values (
    @userId,
    @polarCustomerId,
    @customerExists,
    @syncedAt
  )
  on conflict(userId) do update set
    polarCustomerId = excluded.polarCustomerId,
    customerExists = excluded.customerExists,
    syncedAt = excluded.syncedAt
`);

const upsertSubscription = database.prepare(`
  insert into subscriptions (
    polarSubscriptionId,
    userId,
    polarCustomerId,
    productId,
    tierSlug,
    status,
    currentPeriodEnd,
    canceledAt,
    cancelAtPeriodEnd,
    updatedAt
  )
  values (
    @polarSubscriptionId,
    @userId,
    @polarCustomerId,
    @productId,
    @tierSlug,
    @status,
    @currentPeriodEnd,
    @canceledAt,
    @cancelAtPeriodEnd,
    @updatedAt
  )
  on conflict(polarSubscriptionId) do update set
    userId = excluded.userId,
    polarCustomerId = excluded.polarCustomerId,
    productId = excluded.productId,
    tierSlug = excluded.tierSlug,
    status = excluded.status,
    currentPeriodEnd = excluded.currentPeriodEnd,
    canceledAt = excluded.canceledAt,
    cancelAtPeriodEnd = excluded.cancelAtPeriodEnd,
    updatedAt = excluded.updatedAt
`);

const insertWebhookEvent = database.prepare(`
  insert into webhook_events (
    eventId,
    eventType,
    userId,
    subscriptionId,
    payloadHash,
    processedAt
  )
  values (
    @eventId,
    @eventType,
    @userId,
    @subscriptionId,
    @payloadHash,
    @processedAt
  )
  on conflict(eventId) do nothing
`);

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asBooleanNumber(value: unknown): number {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value !== 0 ? 1 : 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return 1;
  }

  return 0;
}

function toTimestamp(value: unknown): number | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.getTime();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsedNumber = Number.parseInt(value, 10);
    if (!Number.isNaN(parsedNumber)) return parsedNumber;

    const parsedDate = Date.parse(value);
    if (!Number.isNaN(parsedDate)) return parsedDate;
  }

  return null;
}

function getPlanTierByProductId(productId: string): PlanTierConfig | null {
  return config.planTiers.find((tier) => tier.productId === productId) || null;
}

function markCustomerState(
  userId: string,
  customerExists: boolean,
  polarCustomerId: string | null,
  syncedAt = Date.now()
): void {
  upsertSubscriptionCustomer.run({
    userId,
    polarCustomerId,
    customerExists: customerExists ? 1 : 0,
    syncedAt
  });
}

function isRowEntitled(row: SubscriptionRow, now: number): boolean {
  const status = row.status.toLowerCase();

  if (["incomplete", "incomplete_expired", "unpaid", "revoked", "inactive"].includes(status)) {
    return false;
  }

  if (row.currentPeriodEnd !== null && row.currentPeriodEnd <= now) {
    return false;
  }

  return getPlanTierByProductId(row.productId) !== null;
}

function chooseEntitledRow(rows: SubscriptionRow[], now: number): SubscriptionRow | null {
  const entitledRows = rows
    .filter((row) => isRowEntitled(row, now))
    .sort((a, b) => (b.currentPeriodEnd || 0) - (a.currentPeriodEnd || 0));

  return entitledRows[0] || null;
}

function toSubscriptionRow(
  userId: string,
  polarCustomerId: string | null,
  subscription: unknown,
  statusOverride?: string
): SubscriptionRow | null {
  const entry = asObject(subscription);
  const polarSubscriptionId = asString(entry.id);
  const productId = asString(entry.productId || entry.product_id);

  if (!polarSubscriptionId || !productId) {
    return null;
  }

  const tier = getPlanTierByProductId(productId);

  return {
    polarSubscriptionId,
    userId,
    polarCustomerId,
    productId,
    tierSlug: tier?.slug || null,
    status: statusOverride || asString(entry.status) || "unknown",
    currentPeriodEnd: toTimestamp(entry.currentPeriodEnd || entry.current_period_end),
    canceledAt: toTimestamp(entry.canceledAt || entry.canceled_at),
    cancelAtPeriodEnd: asBooleanNumber(entry.cancelAtPeriodEnd || entry.cancel_at_period_end),
    updatedAt: Date.now()
  };
}

function extractUserIdFromSubscription(subscription: unknown): string {
  const entry = asObject(subscription);
  const customer = asObject(entry.customer);
  return asString(customer.externalId || customer.external_id);
}

function extractCustomerIdFromSubscription(subscription: unknown): string | null {
  const entry = asObject(subscription);
  const customer = asObject(entry.customer);
  return asString(entry.customerId || entry.customer_id || customer.id) || null;
}

function getEventInfo(payload: unknown): {
  eventId: string;
  eventType: string;
  userId: string | null;
  subscriptionId: string | null;
  payloadHash: string;
} {
  const root = asObject(payload);
  const data = asObject(root.data);
  const subscriptionId = asString(data.id) || null;
  const eventType = asString(root.type) || "unknown";
  const userId = extractUserIdFromSubscription(data) || asString(data.externalId || data.external_id) || null;
  const payloadHash = createHash("sha256")
    .update(JSON.stringify({ type: eventType, data, subscriptionId }))
    .digest("hex");
  const eventId =
    asString(root.id) ||
    asString(root.eventId || root.event_id) ||
    `${eventType}:${payloadHash}`;

  return {
    eventId,
    eventType,
    userId,
    subscriptionId,
    payloadHash
  };
}

function deactivateMissingSubscriptions(userId: string, activeSubscriptionIds: string[], now: number): void {
  if (activeSubscriptionIds.length === 0) {
    database
      .prepare(
        "update subscriptions set status = 'inactive', updatedAt = ? where userId = ? and status in ('active', 'trialing')"
      )
      .run(now, userId);
    return;
  }

  const placeholders = activeSubscriptionIds.map(() => "?").join(",");
  database
    .prepare(
      `update subscriptions set status = 'inactive', updatedAt = ? where userId = ? and polarSubscriptionId not in (${placeholders}) and status in ('active', 'trialing')`
    )
    .run(now, userId, ...activeSubscriptionIds);
}

function syncCustomerState(fallbackUserId: string, customerState: unknown): void {
  const state = asObject(customerState);
  const userId = asString(state.externalId || state.external_id) || fallbackUserId;

  if (!userId) {
    return;
  }

  const polarCustomerId = asString(state.id) || null;
  const now = Date.now();
  const activeSubscriptionIds: string[] = [];

  markCustomerState(userId, true, polarCustomerId, now);

  for (const subscription of getActiveSubscriptions(customerState)) {
    const row = toSubscriptionRow(userId, polarCustomerId, subscription);
    if (!row) continue;

    activeSubscriptionIds.push(row.polarSubscriptionId);
    upsertSubscription.run(row);
  }

  deactivateMissingSubscriptions(userId, activeSubscriptionIds, now);
}

const syncCustomerStateTx = database.transaction((fallbackUserId: string, customerState: unknown) => {
  syncCustomerState(fallbackUserId, customerState);
});

export function syncSubscriptionsFromCustomerState(
  fallbackUserId: string,
  customerState: unknown
): void {
  syncCustomerStateTx(fallbackUserId, customerState);
}

export function getLocalWeeklyPlanStatus(
  userId: string,
  now = Date.now()
): SubscriptionEntitlement {
  const rows = (getSubscriptionsByUser.all(userId) as SubscriptionRow[]) || [];
  const customerRow = getSubscriptionCustomerByUser.get(userId) as SubscriptionCustomerRow | undefined;
  const entitledRow = chooseEntitledRow(rows, now);
  const tier = entitledRow ? getPlanTierByProductId(entitledRow.productId) : null;

  return {
    active: Boolean(entitledRow && tier),
    tierSlug: tier?.slug || null,
    tier,
    customerExists: rows.length > 0 || Boolean(customerRow?.customerExists),
    source: rows.length > 0 || customerRow ? "local" : "none"
  };
}

export async function resolveWeeklyPlanStatus(userId: string): Promise<SubscriptionEntitlement> {
  const localStatus = getLocalWeeklyPlanStatus(userId);
  const customerRow = getSubscriptionCustomerByUser.get(userId) as SubscriptionCustomerRow | undefined;
  const hasLocalSubscriptionRows =
    ((getSubscriptionsByUser.all(userId) as SubscriptionRow[]) || []).length > 0;

  if (
    localStatus.active ||
    hasLocalSubscriptionRows ||
    (customerRow && Date.now() - customerRow.syncedAt < inactiveStateTtlMs)
  ) {
    return localStatus;
  }

  try {
    const customerState = await polarClient.customers.getStateExternal({ externalId: userId });
    syncSubscriptionsFromCustomerState(userId, customerState);

    return {
      ...getLocalWeeklyPlanStatus(userId),
      customerExists: true,
      source: "polar"
    };
  } catch (error) {
    if (isPolarNotFound(error)) {
      markCustomerState(userId, false, null);

      return {
        active: false,
        tierSlug: null,
        tier: null,
        customerExists: false,
        source: "none"
      };
    }

    throw error;
  }
}

export async function reconcileSubscriptionEntitlements(): Promise<{
  checked: number;
  synced: number;
  missing: number;
  failed: number;
}> {
  const userIds = (listUserIds.all() as string[]).filter((userId) => userId.trim().length > 0);
  const result = {
    checked: 0,
    synced: 0,
    missing: 0,
    failed: 0
  };

  for (const userId of userIds) {
    result.checked += 1;

    try {
      const customerState = await polarClient.customers.getStateExternal({ externalId: userId });
      syncSubscriptionsFromCustomerState(userId, customerState);
      result.synced += 1;
    } catch (error) {
      if (isPolarNotFound(error)) {
        markCustomerState(userId, false, null);
        result.missing += 1;
        continue;
      }

      result.failed += 1;
      console.error(`Subscription reconciliation failed for user ${userId}`, error);
    }
  }

  return result;
}

function applySubscriptionPayload(data: unknown, statusOverride?: string): void {
  const userId = extractUserIdFromSubscription(data);

  if (!userId) {
    return;
  }

  const row = toSubscriptionRow(
    userId,
    extractCustomerIdFromSubscription(data),
    data,
    statusOverride
  );

  if (row) {
    upsertSubscription.run(row);
  }
}

const processWebhookPayloadTx = database.transaction((payload: unknown, statusOverride?: string) => {
  const eventInfo = getEventInfo(payload);
  const insertResult = insertWebhookEvent.run({
    ...eventInfo,
    processedAt: Date.now()
  });

  if (insertResult.changes === 0) {
    return;
  }

  const root = asObject(payload);

  if (eventInfo.eventType === "customer.state_changed") {
    syncCustomerState(eventInfo.userId || "", root.data);
    return;
  }

  applySubscriptionPayload(root.data, statusOverride);
});

export async function processSubscriptionWebhook(
  payload: unknown,
  statusOverride?: string
): Promise<void> {
  processWebhookPayloadTx(payload, statusOverride);
}
