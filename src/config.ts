import path from "node:path";

import dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

function toInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function toBoolean(value: string | undefined, fallback = false): boolean {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export interface AppConfig {
  port: number;
  trustProxy: boolean;
  appApiKey: string;
  corsOrigin: string;
  cliProxyBaseUrl: string;
  cliProxyApiKey: string;
  requestTimeoutMs: number;
  rateLimitWindowMs: number;
  rateLimitAiMax: number;
  rateLimitCodex53Max: number;
  codex53Model: string;
  codex53ReasoningEffort: string;
}

export const config: AppConfig = {
  port: toInt(process.env.PORT, 3000),
  trustProxy: toBoolean(process.env.TRUST_PROXY, false),
  appApiKey: process.env.APP_API_KEY || "",
  corsOrigin: process.env.CORS_ORIGIN || "*",
  cliProxyBaseUrl: (process.env.CLI_PROXY_BASE_URL || "http://127.0.0.1:8317").replace(/\/$/, ""),
  cliProxyApiKey: process.env.CLI_PROXY_API_KEY || "",
  requestTimeoutMs: toInt(process.env.REQUEST_TIMEOUT_MS, 120000),
  rateLimitWindowMs: toInt(process.env.RATE_LIMIT_WINDOW_MS, 60000),
  rateLimitAiMax: toInt(process.env.RATE_LIMIT_AI_MAX, 120),
  rateLimitCodex53Max: toInt(process.env.RATE_LIMIT_CODEX53_MAX, 30),
  codex53Model: process.env.CODEX53_MODEL || "gpt-5.3-codex",
  codex53ReasoningEffort: process.env.CODEX53_REASONING_EFFORT || "low"
};

export function assertRequiredConfig(): void {
  const missing: string[] = [];

  if (!config.cliProxyApiKey) missing.push("CLI_PROXY_API_KEY");

  if (missing.length > 0) {
    throw new Error(`Missing required env values: ${missing.join(", ")}`);
  }
}
