import { fromNodeHeaders } from "better-auth/node";
import express from "express";

import { auth } from "../auth";
import { config } from "../config";
import { asyncHandler } from "../lib/async-handler";

const router = express.Router();

type JsonObject = Record<string, unknown>;

interface AccountRateLimitKey {
  id: string;
  name: string | null;
  start: string | null;
  enabled: boolean;
  windowMs: number;
  max: number;
  used: number;
  remaining: number;
  lastRequestAt: string | null;
  resetAt: string;
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

function toNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
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
  "/rate-limit",
  asyncHandler(async (req, res) => {
    const headers = fromNodeHeaders(req.headers);
    const session = await auth.api.getSession({ headers });

    if (!session?.user) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const apiKeys = await auth.api.listApiKeys({ headers });
    const now = Date.now();
    const normalizedKeys: AccountRateLimitKey[] = [];

    for (const key of apiKeys) {
      const keyAsObject = asObject(key);
      const id = String(keyAsObject.id || "");
      if (!id) continue;

      const enabled = toBoolean(keyAsObject.enabled, true);
      const isRateLimitEnabled = toBoolean(keyAsObject.rateLimitEnabled, true);
      const windowMs = Math.max(
        1,
        toNumber(keyAsObject.rateLimitTimeWindow, config.apiKeyRateLimitWindowMs)
      );
      const max = Math.max(0, toNumber(keyAsObject.rateLimitMax, config.apiKeyRateLimitMax));
      const requestCount = Math.max(0, toNumber(keyAsObject.requestCount, 0));
      const lastRequestTimestamp = toTimestamp(keyAsObject.lastRequest);
      const isWithinWindow =
        lastRequestTimestamp !== null && now - lastRequestTimestamp <= windowMs;
      const used = enabled && isRateLimitEnabled && isWithinWindow ? requestCount : 0;
      const remaining = enabled && isRateLimitEnabled ? Math.max(0, max - used) : max;
      const resetBase = isWithinWindow && lastRequestTimestamp !== null ? lastRequestTimestamp : now;
      const resetAt = toIso(resetBase + windowMs) || new Date(now + windowMs).toISOString();

      normalizedKeys.push({
        id,
        name: typeof keyAsObject.name === "string" ? keyAsObject.name : null,
        start: typeof keyAsObject.start === "string" ? keyAsObject.start : null,
        enabled,
        windowMs,
        max,
        used,
        remaining,
        lastRequestAt: toIso(lastRequestTimestamp),
        resetAt
      });
    }

    normalizedKeys.sort((a, b) => {
      const aName = a.name || a.start || "";
      const bName = b.name || b.start || "";
      return aName.localeCompare(bName);
    });

    const overview = normalizedKeys.reduce(
      (acc, key) => {
        if (!key.enabled) return acc;

        acc.totalMax += key.max;
        acc.totalUsed += key.used;
        acc.totalRemaining += key.remaining;

        const resetTimestamp = Date.parse(key.resetAt);
        if (!Number.isNaN(resetTimestamp)) {
          if (acc.nextResetAt === null || resetTimestamp < Date.parse(acc.nextResetAt)) {
            acc.nextResetAt = key.resetAt;
          }
        }

        return acc;
      },
      {
        activeKeys: 0,
        totalMax: 0,
        totalUsed: 0,
        totalRemaining: 0,
        nextResetAt: null as string | null
      }
    );

    overview.activeKeys = normalizedKeys.filter((key) => key.enabled).length;

    return res.json({
      generatedAt: new Date(now).toISOString(),
      defaults: {
        windowMs: config.apiKeyRateLimitWindowMs,
        max: config.apiKeyRateLimitMax
      },
      overview,
      keys: normalizedKeys
    });
  })
);

export { router as accountRouter };
