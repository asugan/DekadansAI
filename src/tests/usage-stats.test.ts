import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dekadansai-usage-test-"));

process.env.BETTER_AUTH_DATABASE_PATH = path.join(tmpDir, "test.db");

async function loadUsageStats() {
  const { database } = await import("../lib/database.js");

  database
    .prepare("create table if not exists user (id text primary key, name text, email text, emailVerified integer, createdAt integer, updatedAt integer)")
    .run();
  database
    .prepare("insert or ignore into user (id, name, email, emailVerified, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?)")
    .run("user-usage", "Usage User", "usage@example.com", 1, Date.now(), Date.now());

  const usageStats = await import("../lib/usage-stats.js");

  return { database, ...usageStats };
}

void test("extractTokenUsage supports Anthropic usage and count token responses", async () => {
  const { extractTokenUsage } = await loadUsageStats();

  assert.deepEqual(
    extractTokenUsage({
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 3,
        output_tokens: 5
      }
    }),
    {
      inputTokens: 15,
      outputTokens: 5,
      totalTokens: 20
    }
  );

  assert.deepEqual(extractTokenUsage({ input_tokens: 17 }), {
    inputTokens: 17,
    outputTokens: 0,
    totalTokens: 17
  });
});

void test("usage snapshot excludes token count events from inference aggregates", async () => {
  const { database, getUsageSnapshot, recordUsageEvent } = await loadUsageStats();

  recordUsageEvent({
    userId: "user-usage",
    apiKeyId: "key-1",
    model: "claude-sonnet-4",
    endpoint: "/v1/messages",
    statusCode: 200,
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    requestCost: 1
  });
  recordUsageEvent({
    userId: "user-usage",
    apiKeyId: "key-1",
    model: "claude-sonnet-4",
    endpoint: "/v1/messages/count_tokens",
    statusCode: 200,
    inputTokens: 20,
    outputTokens: 0,
    totalTokens: 20,
    requestCost: 0,
    eventType: "token_count",
    billable: false
  });

  const columns = database.prepare("pragma table_info(usage_events)").all() as { name: string }[];
  assert(columns.some((column) => column.name === "eventType"));
  assert(columns.some((column) => column.name === "billable"));

  const snapshot = getUsageSnapshot("user-usage", [
    {
      id: "key-1",
      name: "Test Key",
      start: "cpa_test",
      enabled: true
    }
  ]);

  assert.equal(snapshot.overall.requests, 1);
  assert.equal(snapshot.overall.totalTokens, 15);
  assert.equal(snapshot.byModel[0]?.model, "claude-sonnet-4");
  assert.equal(snapshot.byModel[0]?.requests, 1);
  assert.equal(snapshot.byKey[0]?.requests, 1);
});
