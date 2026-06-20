import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dekadansai-ai-test-"));

process.env.BETTER_AUTH_DATABASE_PATH = path.join(tmpDir, "test.db");
process.env.DEFAULT_MODEL = "gpt-5.3-codex";
process.env.POLAR_PLAN_TIERS = "prod_weekly_500,weekly-500,500,8000,500 Request";

async function loadAiRoutes() {
  const { database } = await import("../lib/database.js");
  database
    .prepare("create table if not exists user (id text primary key, name text, email text, emailVerified integer, createdAt integer, updatedAt integer)")
    .run();

  return import("../routes/ai.js");
}

void test("default AI routes charge the configured default model", async () => {
  const { resolveChargeModel } = await loadAiRoutes();

  assert.equal(
    resolveChargeModel("/default/chat/completions", { model: "kimi-k2.6" }),
    "gpt-5.3-codex"
  );
});

void test("non-default AI routes charge the requested model", async () => {
  const { resolveChargeModel } = await loadAiRoutes();

  assert.equal(resolveChargeModel("/chat/completions", { model: "kimi-k2.6" }), "kimi-k2.6");
});
