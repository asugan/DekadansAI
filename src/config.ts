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

function toPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = toInt(value, fallback);
  return parsed > 0 ? parsed : fallback;
}

function toModelRequestCosts(
  value: string | undefined,
  fallback: Record<string, number>
): Record<string, number> {
  if (value === undefined) {
    return fallback;
  }

  return value.split(",").reduce<Record<string, number>>((costs, entry) => {
    const [rawModel, rawCost] = entry.split(":");
    const model = rawModel?.trim();
    const cost = toInt(rawCost?.trim(), 0);

    if (model && cost > 0) {
      costs[model] = cost;
    }

    return costs;
  }, {});
}

export interface PlanTierConfig {
  productId: string;
  slug: string;
  label: string;
  quotaMax: number;
  weeklyQuotaMax: number;
}

export interface AppConfig {
  port: number;
  trustProxy: boolean;
  corsOrigin: string;
  frontendAppUrl: string;
  cliProxyBaseUrl: string;
  cliProxyApiKey: string;
  requestTimeoutMs: number;
  betterAuthSecret: string;
  betterAuthUrl: string;
  betterAuthTrustedOrigins: string[];
  betterAuthDatabasePath: string;
  apiKeyPrefix: string;
  accountQuotaWindowMs: number;
  weeklyQuotaWindowMs: number;
  planTiers: PlanTierConfig[];
  defaultModelRequestCost: number;
  modelRequestCosts: Record<string, number>;
  accountBurstWindowMs: number;
  accountBurstMax: number;
  polarAccessToken: string;
  polarWebhookSecret: string;
  polarEnvironment: "sandbox" | "production";
  polarCheckoutSuccessUrl: string;
  polarPortalReturnUrl: string;
  defaultModel: string;
  defaultReasoningEffort: string;
}

function toPlanTiers(value: string | undefined): PlanTierConfig[] {
  const raw = value || "";
  if (!raw) return [];

  return raw.split(";").reduce<PlanTierConfig[]>((tiers, entry) => {
    const parts = entry.split(",");
    if (parts.length < 4) return tiers;
    const productId = parts[0]?.trim();
    const slug = parts[1]?.trim();
    const quotaMax = Number.parseInt(parts[2]?.trim(), 10);
    const weeklyQuotaMax = Number.parseInt(parts[3]?.trim(), 10);
    const label = parts[4]?.trim() || slug;
    if (productId && slug && quotaMax > 0 && weeklyQuotaMax > 0) {
      tiers.push({ productId, slug, label, quotaMax, weeklyQuotaMax });
    }
    return tiers;
  }, []);
}

function isUnsafeProductionUrl(value: string): boolean {
  const normalized = value.trim().toLowerCase();

  return (
    normalized.includes("localhost") ||
    normalized.includes("127.0.0.1") ||
    normalized.includes("0.0.0.0") ||
    normalized.includes("ngrok") ||
    normalized.includes("lvh.me")
  );
}

function assertSafeProductionUrl(name: string, value: string): void {
  if (!value || isUnsafeProductionUrl(value)) {
    throw new Error(`${name} must be a production URL when NODE_ENV=production`);
  }
}

export const config: AppConfig = {
  port: toInt(process.env.PORT, 3000),
  trustProxy: toBoolean(process.env.TRUST_PROXY, false),
  corsOrigin: process.env.CORS_ORIGIN || "*",
  frontendAppUrl: (process.env.FRONTEND_APP_URL || "http://localhost:3000").replace(/\/$/, ""),
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
  accountQuotaWindowMs: toInt(process.env.ACCOUNT_QUOTA_WINDOW_MS, 18000000),
  weeklyQuotaWindowMs: toInt(process.env.WEEKLY_QUOTA_WINDOW_MS, 604800000),
  planTiers: toPlanTiers(
    process.env.POLAR_PLAN_TIERS ||
      ""
  ),
  defaultModelRequestCost: toPositiveInt(process.env.DEFAULT_MODEL_REQUEST_COST, 1),
  modelRequestCosts: toModelRequestCosts(process.env.MODEL_REQUEST_COSTS, {
    "gpt-5.5": 3,
    "kimi-k2.6": 1
  }),
  accountBurstWindowMs: toInt(process.env.ACCOUNT_BURST_WINDOW_MS, 20000),
  accountBurstMax: toInt(process.env.ACCOUNT_BURST_MAX, 5),
  polarAccessToken: process.env.POLAR_ACCESS_TOKEN || "",
  polarWebhookSecret: process.env.POLAR_WEBHOOK_SECRET || "",
  polarEnvironment: process.env.POLAR_ENVIRONMENT === "production" ? "production" : "sandbox",
  polarCheckoutSuccessUrl:
    process.env.POLAR_CHECKOUT_SUCCESS_URL ||
    `${(process.env.FRONTEND_APP_URL || "http://localhost:3000").replace(/\/$/, "")}/dashboard?checkout=success`,
  polarPortalReturnUrl:
    process.env.POLAR_PORTAL_RETURN_URL ||
    `${(process.env.FRONTEND_APP_URL || "http://localhost:3000").replace(/\/$/, "")}/dashboard`,
  defaultModel: process.env.DEFAULT_MODEL || "gpt-5.3-codex",
  defaultReasoningEffort: process.env.DEFAULT_REASONING_EFFORT || "low"
};

export function assertRequiredConfig(): void {
  const missing: string[] = [];

  if (!config.cliProxyApiKey) missing.push("CLI_PROXY_API_KEY");
  if (!config.betterAuthSecret) missing.push("BETTER_AUTH_SECRET");
  if (!config.polarAccessToken) missing.push("POLAR_ACCESS_TOKEN");
  if (!config.polarWebhookSecret) missing.push("POLAR_WEBHOOK_SECRET");
  if (config.planTiers.length === 0) missing.push("POLAR_PLAN_TIERS");
  if (config.betterAuthSecret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must be at least 32 characters");
  }

  if (process.env.NODE_ENV === "production") {
    if (config.corsOrigin === "*") {
      throw new Error("CORS_ORIGIN must be an explicit allowlist when NODE_ENV=production");
    }

    for (const origin of config.corsOrigin.split(",").map((item) => item.trim()).filter(Boolean)) {
      assertSafeProductionUrl("CORS_ORIGIN", origin);
    }

    assertSafeProductionUrl("FRONTEND_APP_URL", config.frontendAppUrl);
    assertSafeProductionUrl("BETTER_AUTH_URL", config.betterAuthUrl);
    assertSafeProductionUrl("POLAR_CHECKOUT_SUCCESS_URL", config.polarCheckoutSuccessUrl);
    assertSafeProductionUrl("POLAR_PORTAL_RETURN_URL", config.polarPortalReturnUrl);
  }

  if (missing.length > 0) {
    throw new Error(`Missing required env values: ${missing.join(", ")}`);
  }
}
