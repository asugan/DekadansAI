import { fromNodeHeaders } from "better-auth/node";
import express from "express";

import { auth } from "../auth";
import { getAccountRateLimitSnapshot } from "../lib/account-rate-limit";
import { asyncHandler } from "../lib/async-handler";
import { polarClient } from "../lib/polar";
import { getWeeklyPlanStatus, isPolarNotFound } from "../lib/polar-state";

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

    try {
      const customerState = await polarClient.customers.getStateExternal({
        externalId: session.user.id
      });
      const weeklyPlan = getWeeklyPlanStatus(customerState);

      return res.json({
        generatedAt: new Date().toISOString(),
        weeklyPlan
      });
    } catch (error) {
      if (isPolarNotFound(error)) {
        return res.json({
          generatedAt: new Date().toISOString(),
          weeklyPlan: {
            active: false,
            customerExists: false
          }
        });
      }

      throw error;
    }
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

    const apiKeys = await auth.api.listApiKeys({ headers });
    const now = Date.now();
    const accountSnapshot = getAccountRateLimitSnapshot(session.user.id, now);
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
      account: accountSnapshot,
      overview,
      keys: normalizedKeys
    });
  })
);

export { router as accountRouter };
