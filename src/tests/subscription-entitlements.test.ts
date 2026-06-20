import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dekadansai-entitlement-test-"));
const futurePeriodEnd = Date.now() + 86_400_000;

process.env.BETTER_AUTH_DATABASE_PATH = path.join(tmpDir, "test.db");
process.env.POLAR_PLAN_TIERS = "prod_weekly_500,weekly-500,500,8000,500 Request";
process.env.DEFAULT_MODEL_REQUEST_COST = "3";

async function loadTestModules() {
  const databaseModule = await import("../lib/database.js");

  databaseModule.database
    .prepare("create table if not exists user (id text primary key, name text, email text, emailVerified integer, createdAt integer, updatedAt integer)")
    .run();

  const accountRateLimit = await import("../lib/account-rate-limit.js");
  const polarModule = await import("../lib/polar.js");
  const entitlements = await import("../lib/subscription-entitlements.js");

  return {
    ...accountRateLimit,
    database: databaseModule.database,
    polarClient: polarModule.polarClient,
    resolveWeeklyPlanStatus: entitlements.resolveWeeklyPlanStatus
  };
}

void test("SQLite foreign key enforcement is enabled", async () => {
  const { database } = await loadTestModules();

  assert.equal(database.pragma("foreign_keys", { simple: true }), 1);
});

void test("quota refund restores reserved request cost", async () => {
  const { consumeAccountRateLimit, database, refundAccountRateLimit } = await loadTestModules();
  const tier = {
    productId: "prod_weekly_500",
    slug: "weekly-500",
    label: "500 Request",
    quotaMax: 500,
    weeklyQuotaMax: 8000
  };

  database
    .prepare("insert into user (id, name, email, emailVerified, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?)")
    .run("user-rate", "Rate User", "rate@example.com", 1, Date.now(), Date.now());

  const consumed = consumeAccountRateLimit("user-rate", tier, 3);
  assert.equal(consumed.allowed, true);
  assert.equal(consumed.snapshot.quota.used, 3);

  const refunded = refundAccountRateLimit("user-rate", tier, 3);
  assert.equal(refunded.quota.used, 0);
  assert.equal(refunded.weekly?.used, 0);
});

void test("fresh inactive subscription state does not call Polar", async () => {
  const { database, polarClient, resolveWeeklyPlanStatus } = await loadTestModules();

  database
    .prepare("insert into user (id, name, email, emailVerified, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?)")
    .run("user-fresh", "Fresh User", "fresh@example.com", 1, Date.now(), Date.now());
  database
    .prepare(
      "insert into subscription_customers (userId, polarCustomerId, customerExists, syncedAt) values (?, ?, ?, ?)"
    )
    .run("user-fresh", "cust-fresh", 1, Date.now());

  let called = false;
  const originalGetStateExternal = polarClient.customers.getStateExternal.bind(polarClient.customers);
  polarClient.customers.getStateExternal = async () => {
    called = true;
    throw new Error("Polar should not be called for fresh inactive state");
  };

  try {
    const status = await resolveWeeklyPlanStatus("user-fresh");
    assert.equal(status.active, false);
    assert.equal(called, false);
  } finally {
    polarClient.customers.getStateExternal = originalGetStateExternal;
  }
});

void test("stale inactive subscription state hydrates from Polar", async () => {
  const { database, polarClient, resolveWeeklyPlanStatus } = await loadTestModules();

  database
    .prepare("insert into user (id, name, email, emailVerified, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?)")
    .run("user-stale", "Stale User", "stale@example.com", 1, Date.now(), Date.now());
  database
    .prepare(
      "insert into subscription_customers (userId, polarCustomerId, customerExists, syncedAt) values (?, ?, ?, ?)"
    )
    .run("user-stale", "cust-stale", 1, Date.now() - 120_000);

  let called = false;
  const originalGetStateExternal = polarClient.customers.getStateExternal.bind(polarClient.customers);
  polarClient.customers.getStateExternal = async () => {
    called = true;
    return {
      id: "cust-stale",
      externalId: "user-stale",
      activeSubscriptions: [
        {
          id: "sub-stale",
          productId: "prod_weekly_500",
          status: "active",
          currentPeriodEnd: futurePeriodEnd
        }
      ]
    } as unknown as Awaited<ReturnType<typeof polarClient.customers.getStateExternal>>;
  };

  try {
    const status = await resolveWeeklyPlanStatus("user-stale");
    assert.equal(called, true);
    assert.equal(status.active, true);
    assert.equal(status.tierSlug, "weekly-500");
  } finally {
    polarClient.customers.getStateExternal = originalGetStateExternal;
  }
});
