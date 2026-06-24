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

function getRoutePaths(router: unknown, method: "get" | "post"): string[] {
  const stack = (router as {
    stack?: Array<{ route?: { path?: string; methods?: Record<string, boolean> } }>;
  }).stack || [];

  return stack
    .filter((layer) => layer.route?.methods?.[method])
    .map((layer) => layer.route?.path)
    .filter((path): path is string => typeof path === "string");
}

void test("AI routes charge the requested model", async () => {
  const { resolveChargeModel } = await loadAiRoutes();

  assert.equal(resolveChargeModel("/chat/completions", { model: "kimi-k2.6" }), "kimi-k2.6");
});

void test("anthropic messages route charges the requested model", async () => {
  const { resolveChargeModel } = await loadAiRoutes();

  assert.equal(resolveChargeModel("/messages", { model: "claude-sonnet-4" }), "claude-sonnet-4");
});

void test("v1 router exposes only standard compatible routes", async () => {
  const { v1Router } = await loadAiRoutes();

  assert.deepEqual(getRoutePaths(v1Router, "get"), ["/models"]);
  assert.deepEqual(getRoutePaths(v1Router, "post"), [
    "/chat/completions",
    "/responses",
    "/messages",
    "/messages/count_tokens"
  ]);
});
