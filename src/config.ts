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

function toStringArray(value: string | undefined, fallback: string[] = []): string[] {
  if (value === undefined) {
    return fallback;
  }

  const parsed = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  if (parsed.length === 0) {
    return fallback;
  }

  return parsed;
}

export interface AppConfig {
  port: number;
  trustProxy: boolean;
  corsOrigin: string;
  cliProxyBaseUrl: string;
  cliProxyApiKey: string;
  requestTimeoutMs: number;
  betterAuthSecret: string;
  betterAuthUrl: string;
  betterAuthTrustedOrigins: string[];
  betterAuthDatabasePath: string;
  apiKeyPrefix: string;
  apiKeyRateLimitWindowMs: number;
  apiKeyRateLimitMax: number;
  codex53Model: string;
  codex53ReasoningEffort: string;
}

export const config: AppConfig = {
  port: toInt(process.env.PORT, 3000),
  trustProxy: toBoolean(process.env.TRUST_PROXY, false),
  corsOrigin: process.env.CORS_ORIGIN || "*",
  cliProxyBaseUrl: (process.env.CLI_PROXY_BASE_URL || "http://127.0.0.1:8317").replace(/\/$/, ""),
  cliProxyApiKey: process.env.CLI_PROXY_API_KEY || "",
  requestTimeoutMs: toInt(process.env.REQUEST_TIMEOUT_MS, 120000),
  betterAuthSecret: process.env.BETTER_AUTH_SECRET || "",
  betterAuthUrl: process.env.BETTER_AUTH_URL || "http://localhost:3000",
  betterAuthTrustedOrigins: toStringArray(process.env.BETTER_AUTH_TRUSTED_ORIGINS, [
    "http://localhost:3000",
    "http://127.0.0.1:3000"
  ]),
  betterAuthDatabasePath: process.env.BETTER_AUTH_DATABASE_PATH || "./data/better-auth.db",
  apiKeyPrefix: process.env.API_KEY_PREFIX || "cpa_",
  apiKeyRateLimitWindowMs: toInt(process.env.API_KEY_RATE_LIMIT_WINDOW_MS, 60000),
  apiKeyRateLimitMax: toInt(process.env.API_KEY_RATE_LIMIT_MAX, 30),
  codex53Model: process.env.CODEX53_MODEL || "gpt-5.3-codex",
  codex53ReasoningEffort: process.env.CODEX53_REASONING_EFFORT || "low"
};

export function assertRequiredConfig(): void {
  const missing: string[] = [];

  if (!config.cliProxyApiKey) missing.push("CLI_PROXY_API_KEY");
  if (!config.betterAuthSecret) missing.push("BETTER_AUTH_SECRET");
  if (config.betterAuthSecret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must be at least 32 characters");
  }

  if (missing.length > 0) {
    throw new Error(`Missing required env values: ${missing.join(", ")}`);
  }
}
