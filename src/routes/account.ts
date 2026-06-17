import { fromNodeHeaders } from "better-auth/node";
import express from "express";

import { auth } from "../auth";
import { config } from "../config";
import { getAccountRateLimitSnapshot } from "../lib/account-rate-limit";
import { asyncHandler } from "../lib/async-handler";
import { fetchModelCatalog } from "../lib/model-catalog";
import { resolveWeeklyPlanStatus } from "../lib/subscription-entitlements";

const router = express.Router();

type JsonObject = Record<string, unknown>;

interface AccountRateLimitKey {
  id: string;
  name: string | null;
  start: string | null;
  enabled: boolean;
  lastRequestAt: string | null;
}

function asObject(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }

  return {};
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }

  return fallback;
}

function toTimestamp(value: unknown): number | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.getTime();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;

    const asNumber = Number.parseInt(trimmed, 10);
    if (!Number.isNaN(asNumber)) {
      return asNumber;
    }

    const asDate = Date.parse(trimmed);
    return Number.isNaN(asDate) ? null : asDate;
  }

  return null;
}

function toIso(value: number | null): string | null {
  if (value === null) return null;
  return new Date(value).toISOString();
}

router.get(
  "/billing",
  asyncHandler(async (req, res) => {
    const headers = fromNodeHeaders(req.headers);
    const session = await auth.api.getSession({ headers });

    if (!session?.user) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const weeklyPlan = await resolveWeeklyPlanStatus(session.user.id);

    return res.json({
      generatedAt: new Date().toISOString(),
      weeklyPlan: {
        active: weeklyPlan.active,
        tierSlug: weeklyPlan.tierSlug,
        tier: weeklyPlan.tier
          ? {
              slug: weeklyPlan.tier.slug,
              label: weeklyPlan.tier.label,
              quotaMax: weeklyPlan.tier.quotaMax,
              weeklyQuotaMax: weeklyPlan.tier.weeklyQuotaMax
            }
          : null,
        customerExists: weeklyPlan.customerExists
      },
      planTiers: config.planTiers.map((t) => ({
        slug: t.slug,
        label: t.label,
        quotaMax: t.quotaMax,
        weeklyQuotaMax: t.weeklyQuotaMax
      }))
    });
  })
);

router.get(
  "/rate-limit",
  asyncHandler(async (req, res) => {
    const headers = fromNodeHeaders(req.headers);
    const session = await auth.api.getSession({ headers });

    if (!session?.user) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const planStatus = await resolveWeeklyPlanStatus(session.user.id);
    const planTier = planStatus.tier || config.planTiers[0];

    const apiKeys = await auth.api.listApiKeys({ headers });
    const now = Date.now();
    const accountSnapshot = getAccountRateLimitSnapshot(session.user.id, planTier, now);
    const normalizedKeys: AccountRateLimitKey[] = [];

    for (const key of apiKeys) {
      const keyAsObject = asObject(key);
      const id = String(keyAsObject.id || "");
      if (!id) continue;

      const enabled = toBoolean(keyAsObject.enabled, true);
      const lastRequestTimestamp = toTimestamp(keyAsObject.lastRequest);

      normalizedKeys.push({
        id,
        name: typeof keyAsObject.name === "string" ? keyAsObject.name : null,
        start: typeof keyAsObject.start === "string" ? keyAsObject.start : null,
        enabled,
        lastRequestAt: toIso(lastRequestTimestamp)
      });
    }

    normalizedKeys.sort((a, b) => {
      const aName = a.name || a.start || "";
      const bName = b.name || b.start || "";
      return aName.localeCompare(bName);
    });

    const overview = {
      activeKeys: normalizedKeys.filter((key) => key.enabled).length,
      totalMax: accountSnapshot.quota.max,
      totalUsed: accountSnapshot.quota.used,
      totalRemaining: accountSnapshot.quota.remaining,
      nextResetAt: accountSnapshot.quota.resetAt
    };

    return res.json({
      generatedAt: new Date(now).toISOString(),
      defaults: {
        windowMs: accountSnapshot.quota.windowMs,
        max: accountSnapshot.quota.max
      },
      tier: {
        slug: planTier.slug,
        label: planTier.label,
        quotaMax: planTier.quotaMax,
        weeklyQuotaMax: planTier.weeklyQuotaMax
      },
      account: accountSnapshot,
      overview,
      keys: normalizedKeys
    });
  })
);

router.get(
  "/models",
  asyncHandler(async (req, res) => {
    const headers = fromNodeHeaders(req.headers);
    const session = await auth.api.getSession({ headers });

    if (!session?.user) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const catalog = await fetchModelCatalog();

    if (!catalog.ok) {
      return res.status(catalog.status).json(catalog.payload || { error: "models_unavailable" });
    }

    return res.json({
      generatedAt: new Date().toISOString(),
      data: catalog.models
    });
  })
);

export { router as accountRouter };
