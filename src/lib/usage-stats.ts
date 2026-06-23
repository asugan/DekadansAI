import crypto from "node:crypto";

import { database } from "./database";

type JsonObject = Record<string, unknown>;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface UsageEventInput extends TokenUsage {
  userId: string;
  apiKeyId: string | null;
  model: string | null;
  endpoint: string;
  statusCode: number;
  requestCost: number;
  eventType?: "inference" | "token_count";
  billable?: boolean;
}

interface UsageAggregateRow {
  requests: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  tokenValue: number | null;
  lastRequestAt: number | null;
}

interface UsageByKeyRow extends UsageAggregateRow {
  apiKeyId: string | null;
}

interface UsageByModelRow extends UsageAggregateRow {
  model: string | null;
}

export interface UsageKeyInfo {
  id: string;
  name: string | null;
  start: string | null;
  enabled: boolean;
}

function asObject(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }

  return {};
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isNaN(parsed)) return Math.max(0, parsed);
  }

  return 0;
}

function toIso(value: number | null | undefined): string | null {
  if (!value) return null;
  return new Date(value).toISOString();
}

database
  .prepare(
    `
    create table if not exists usage_events (
      id text not null primary key,
      userId text not null references user(id) on delete cascade,
      apiKeyId text,
      model text,
      endpoint text not null,
      statusCode integer not null,
      inputTokens integer not null default 0,
      outputTokens integer not null default 0,
      totalTokens integer not null default 0,
      tokenValue real not null default 0,
      requestCost integer not null default 0,
      createdAt integer not null
    )
  `
  )
  .run();

function ensureColumn(table: string, column: string, definition: string): void {
  const rows = database.prepare(`pragma table_info(${table})`).all() as { name: string }[];
  if (rows.some((row) => row.name === column)) return;
  database.prepare(`alter table ${table} add column ${column} ${definition}`).run();
}

ensureColumn("usage_events", "eventType", "text not null default 'inference'");
ensureColumn("usage_events", "billable", "integer not null default 1");

database.prepare("create index if not exists usage_events_userId_idx on usage_events(userId)").run();
database.prepare("create index if not exists usage_events_apiKeyId_idx on usage_events(apiKeyId)").run();
database.prepare("create index if not exists usage_events_model_idx on usage_events(model)").run();
database.prepare("create index if not exists usage_events_createdAt_idx on usage_events(createdAt)").run();
database.prepare("create index if not exists usage_events_eventType_idx on usage_events(eventType)").run();

const insertUsageEvent = database.prepare(`
  insert into usage_events (
    id,
    userId,
    apiKeyId,
    model,
    endpoint,
    statusCode,
    inputTokens,
    outputTokens,
    totalTokens,
    tokenValue,
    requestCost,
    eventType,
    billable,
    createdAt
  )
  values (
    @id,
    @userId,
    @apiKeyId,
    @model,
    @endpoint,
    @statusCode,
    @inputTokens,
    @outputTokens,
    @totalTokens,
    @tokenValue,
    @requestCost,
    @eventType,
    @billable,
    @createdAt
  )
`);

const overallUsage = database
  .prepare(
    `
    select
      count(*) as requests,
      coalesce(sum(inputTokens), 0) as inputTokens,
      coalesce(sum(outputTokens), 0) as outputTokens,
      coalesce(sum(totalTokens), 0) as totalTokens,
      coalesce(sum(tokenValue), 0) as tokenValue,
      max(createdAt) as lastRequestAt
    from usage_events
    where userId = ? and eventType = 'inference'
  `
  )
  .pluck(false);

const usageByKey = database
  .prepare(
    `
    select
      apiKeyId,
      count(*) as requests,
      coalesce(sum(inputTokens), 0) as inputTokens,
      coalesce(sum(outputTokens), 0) as outputTokens,
      coalesce(sum(totalTokens), 0) as totalTokens,
      coalesce(sum(tokenValue), 0) as tokenValue,
      max(createdAt) as lastRequestAt
    from usage_events
    where userId = ? and eventType = 'inference'
    group by apiKeyId
  `
  );

const usageByModel = database
  .prepare(
    `
    select
      model,
      count(*) as requests,
      coalesce(sum(inputTokens), 0) as inputTokens,
      coalesce(sum(outputTokens), 0) as outputTokens,
      coalesce(sum(totalTokens), 0) as totalTokens,
      coalesce(sum(tokenValue), 0) as tokenValue,
      max(createdAt) as lastRequestAt
    from usage_events
    where userId = ? and eventType = 'inference' and model is not null and model != ''
    group by model
    order by totalTokens desc, requests desc
  `
  );

export function extractTokenUsage(payload: unknown): TokenUsage {
  const root = asObject(payload);
  const usage = asObject(root.usage);

  const inputTokens =
    toNumber(usage.input_tokens ?? root.input_tokens ?? usage.prompt_tokens) +
    toNumber(usage.cache_creation_input_tokens) +
    toNumber(usage.cache_read_input_tokens);
  const outputTokens = toNumber(usage.output_tokens ?? usage.completion_tokens);
  const totalTokens = toNumber(usage.total_tokens) || inputTokens + outputTokens;

  return {
    inputTokens,
    outputTokens,
    totalTokens
  };
}

export function recordUsageEvent(input: UsageEventInput): void {
  const createdAt = Date.now();
  const totalTokens = input.totalTokens || input.inputTokens + input.outputTokens;

  insertUsageEvent.run({
    id: crypto.randomUUID(),
    userId: input.userId,
    apiKeyId: input.apiKeyId,
    model: input.model,
    endpoint: input.endpoint,
    statusCode: input.statusCode,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    totalTokens,
    tokenValue: totalTokens,
    requestCost: input.requestCost,
    eventType: input.eventType || "inference",
    billable: input.billable === false ? 0 : 1,
    createdAt
  });
}

function aggregate(row: UsageAggregateRow | undefined) {
  return {
    requests: Math.max(0, toNumber(row?.requests)),
    inputTokens: Math.max(0, toNumber(row?.inputTokens)),
    outputTokens: Math.max(0, toNumber(row?.outputTokens)),
    totalTokens: Math.max(0, toNumber(row?.totalTokens)),
    tokenValue: Math.max(0, Number(row?.tokenValue || 0)),
    lastRequestAt: toIso(row?.lastRequestAt)
  };
}

export function getUsageSnapshot(userId: string, keys: UsageKeyInfo[]) {
  const keyRows = usageByKey.all(userId) as UsageByKeyRow[];
  const keyUsage = new Map<string, UsageByKeyRow>();
  let unknownKeyUsage: UsageByKeyRow | undefined;

  for (const row of keyRows) {
    if (row.apiKeyId) {
      keyUsage.set(row.apiKeyId, row);
    } else {
      unknownKeyUsage = row;
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    overall: aggregate(overallUsage.get(userId) as UsageAggregateRow | undefined),
    byKey: keys.map((key) => ({
      id: key.id,
      name: key.name,
      start: key.start,
      enabled: key.enabled,
      ...aggregate(keyUsage.get(key.id))
    })),
    unknownKey: unknownKeyUsage ? aggregate(unknownKeyUsage) : null,
    byModel: (usageByModel.all(userId) as UsageByModelRow[]).map((row) => ({
      model: row.model || "unknown",
      ...aggregate(row)
    }))
  };
}
