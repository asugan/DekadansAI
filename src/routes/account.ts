import { fromNodeHeaders } from "better-auth/node";
import express from "express";

import { auth } from "../auth";
import { getAccountRateLimitSnapshot } from "../lib/account-rate-limit";
import { asyncHandler } from "../lib/async-handler";
import { polarClient } from "../lib/polar";
import { getWeeklyPlanStatus, isPolarNotFound } from "../lib/polar-state";
import { decodeResponse, requestInference } from "../services/cliproxy-client";

const router = express.Router();

type JsonObject = Record<string, unknown>;

interface AccountRateLimitKey {
  id: string;
  name: string | null;
  start: string | null;
  enabled: boolean;
  lastRequestAt: string | null;
}

interface AccountModel {
  id: string;
  name: string;
  provider: string | null;
  enabled: boolean;
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

function humanizeModelName(id: string): string {
  return id
    .split(/[-_:./]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function providerFromModel(model: JsonObject, id: string): string | null {
  const provider = model.provider || model.owned_by || model.owner;
  if (typeof provider === "string" && provider.trim()) {
    return provider;
  }

  const [prefix] = id.split(/[-_:./]+/);
  return prefix ? prefix.toLowerCase() : null;
}

function normalizeModels(payload: unknown): AccountModel[] {
  const root = asObject(payload);
  const rawModels = Array.isArray(root.data)
    ? root.data
    : Array.isArray(root.models)
      ? root.models
      : Array.isArray(payload)
        ? payload
        : [];

  const models = rawModels
    .map((entry): AccountModel | null => {
      if (typeof entry === "string") {
        return {
          id: entry,
          name: humanizeModelName(entry),
          provider: providerFromModel({}, entry),
          enabled: true
        } satisfies AccountModel;
      }

      const model = asObject(entry);
      const idValue = model.id || model.name || model.model;
      const id = typeof idValue === "string" ? idValue.trim() : "";
      if (!id) return null;

      const nameValue = model.displayName || model.display_name || model.label || model.name;
      const enabled = toBoolean(model.enabled ?? model.active ?? model.available, true);

      if (!enabled) return null;

      return {
        id,
        name: typeof nameValue === "string" && nameValue.trim() ? nameValue : humanizeModelName(id),
        provider: providerFromModel(model, id),
        enabled
      } satisfies AccountModel;
    })
    .filter((entry): entry is AccountModel => entry !== null);

  return models.sort((a, b) => a.name.localeCompare(b.name));
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

router.get(
  "/models",
  asyncHandler(async (req, res) => {
    const headers = fromNodeHeaders(req.headers);
    const session = await auth.api.getSession({ headers });

    if (!session?.user) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const upstreamResponse = await requestInference({ method: "GET", pathname: "/v1/models" });
    const payload = await decodeResponse(upstreamResponse);

    if (!upstreamResponse.ok) {
      return res.status(upstreamResponse.status).json(payload || { error: "models_unavailable" });
    }

    return res.json({
      generatedAt: new Date().toISOString(),
      data: normalizeModels(payload)
    });
  })
);

export { router as accountRouter };
