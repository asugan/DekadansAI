import express, { type Request, type Response } from "express";

import { config, type PlanTierConfig } from "../config";
import {
  consumeAccountRateLimit,
  getModelRequestCost,
  refundAccountRateLimit
} from "../lib/account-rate-limit";
import { asyncHandler } from "../lib/async-handler";
import { sanitizePublicModelPayload } from "../lib/model-catalog";
import { extractTokenUsage, recordUsageEvent } from "../lib/usage-stats";
import {
  decodeResponse,
  pipeUpstreamResponse,
  requestInference
} from "../services/cliproxy-client";

const router = express.Router();

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }

  return {};
}

function defaultChatPayload(body: unknown): JsonObject {
  const payload = asObject(body);

  return {
    ...payload,
    model: config.defaultModel,
    reasoning_effort:
      payload.reasoning_effort === undefined ? config.defaultReasoningEffort : payload.reasoning_effort
  };
}

function defaultResponsesPayload(body: unknown): JsonObject {
  const payload = asObject(body);
  const reasoning = asObject(payload.reasoning);

  return {
    ...payload,
    model: config.defaultModel,
    reasoning:
      Object.keys(reasoning).length > 0
        ? reasoning
        : {
            effort: config.defaultReasoningEffort
          }
  };
}

function getRequestedModel(body: unknown): string {
  const payload = asObject(body);
  return typeof payload.model === "string" ? payload.model.trim() : "";
}

export function resolveChargeModel(reqPath: string, payload: unknown): string {
  return reqPath.startsWith("/default/") ? config.defaultModel : getRequestedModel(payload);
}

function getPlanTierOrDefault(tier?: PlanTierConfig): PlanTierConfig {
  if (tier) return tier;
  return config.planTiers[0] || { productId: "", slug: "default", label: "Default", quotaMax: 500, weeklyQuotaMax: 8000 };
}

function setRateLimitHeaders(
  res: Response,
  snapshot: { quota: { max: number; remaining: number; resetAt: string }; weekly?: { max: number; remaining: number } },
  quotaCost: number
): void {
  res.setHeader("RateLimit-Limit", String(snapshot.quota.max));
  res.setHeader("RateLimit-Remaining", String(snapshot.quota.remaining));
  res.setHeader("X-RateLimit-Request-Cost", String(quotaCost));
  res.setHeader("RateLimit-Reset", String(Math.ceil(new Date(snapshot.quota.resetAt).getTime() / 1000)));
  if (snapshot.weekly) {
    res.setHeader("X-Weekly-Limit", String(snapshot.weekly.max));
    res.setHeader("X-Weekly-Remaining", String(snapshot.weekly.remaining));
  }
}

function reserveInferenceQuota(res: Response, modelId: string): ReturnType<typeof consumeAccountRateLimit> | null {
  const userId = typeof res.locals.userId === "string" ? res.locals.userId : "";

  if (!userId) {
    res.status(401).json({ error: "unauthorized" });
    return null;
  }

  const planTier = getPlanTierOrDefault(res.locals.planTier);
  const result = consumeAccountRateLimit(userId, planTier, getModelRequestCost(modelId));

  if (!result.allowed) {
    setRateLimitHeaders(res, result.snapshot, result.quotaCost);
    if (result.retryAfterMs > 0) {
      res.setHeader("Retry-After", String(Math.ceil(result.retryAfterMs / 1000)));
    }

    res.status(429).json({
      error: "account_rate_limit_exceeded",
      reason: result.reason,
      retryAfterMs: result.retryAfterMs,
      requestCost: result.quotaCost,
      quota: result.snapshot.quota,
      burst: result.snapshot.burst,
      weekly: result.snapshot.weekly
    });
    return null;
  }

  res.locals.accountRateLimit = result.snapshot;
  res.locals.accountRateLimitCost = result.quotaCost;
  res.locals.planTier = planTier;
  return result;
}

function requireModel(req: Request, res: Response): boolean {
  if (getRequestedModel(req.body)) {
    return true;
  }

  res.status(400).json({
    error: "missing_model",
    message: "Request body must include a model id."
  });
  return false;
}

async function proxyJsonRequest(
  req: Request,
  res: Response,
  pathname: string,
  payload: unknown = req.body,
  quotaInfo?: { userId: string; planTier: PlanTierConfig; quotaCost: number; modelId: string }
): Promise<void> {
  let upstreamResponse: globalThis.Response;

  try {
    upstreamResponse = await requestInference({
      method: req.method,
      pathname,
      body: payload
    });
  } catch (error) {
    if (quotaInfo) {
      const snapshot = refundAccountRateLimit(
        quotaInfo.userId,
        quotaInfo.planTier,
        quotaInfo.quotaCost
      );
      setRateLimitHeaders(res, snapshot, quotaInfo.quotaCost);
    }

    throw error;
  }

  const shouldRefund = upstreamResponse.status >= 500;
  let currentSnapshot = res.locals.accountRateLimit as
    | { quota: { max: number; remaining: number; resetAt: string }; weekly?: { max: number; remaining: number } }
    | undefined;
  let currentQuotaCost = typeof res.locals.accountRateLimitCost === "number" ? res.locals.accountRateLimitCost : 0;

  if (shouldRefund && quotaInfo) {
    currentSnapshot = refundAccountRateLimit(quotaInfo.userId, quotaInfo.planTier, quotaInfo.quotaCost);
    currentQuotaCost = quotaInfo.quotaCost;
  }

  if (currentSnapshot) {
    setRateLimitHeaders(res, currentSnapshot, currentQuotaCost);
  }

  const contentType = upstreamResponse.headers.get("content-type") || "";
  const bodyAsObject = asObject(payload);
  const isStreaming = bodyAsObject.stream === true || contentType.includes("text/event-stream");

  if (isStreaming) {
    await pipeUpstreamResponse(upstreamResponse, res);
    return;
  }

  const responsePayload = await decodeResponse(upstreamResponse);
  if (quotaInfo && upstreamResponse.status < 500) {
    const usage = extractTokenUsage(responsePayload);
    const apiKeyId = typeof res.locals.apiKeyId === "string" ? res.locals.apiKeyId : null;

    recordUsageEvent({
      userId: quotaInfo.userId,
      apiKeyId,
      model: quotaInfo.modelId || null,
      endpoint: pathname,
      statusCode: upstreamResponse.status,
      requestCost: quotaInfo.quotaCost,
      ...usage
    });
  }
  res.status(upstreamResponse.status).json(responsePayload || {});
}

router.get(
  "/models",
  asyncHandler(async (_req, res) => {
    const upstreamResponse = await requestInference({ method: "GET", pathname: "/v1/models" });
    const payload = await decodeResponse(upstreamResponse);
    res.status(upstreamResponse.status).json(sanitizePublicModelPayload(payload || {}));
  })
);

router.post(
  "/chat/completions",
  asyncHandler(async (req, res) => {
    if (!requireModel(req, res)) return;
    const userId = typeof res.locals.userId === "string" ? res.locals.userId : "";
    const planTier = getPlanTierOrDefault(res.locals.planTier);
    const modelId = resolveChargeModel(req.path, req.body);
    const quotaInfo = reserveInferenceQuota(res, modelId);
    if (!quotaInfo) return;

    await proxyJsonRequest(req, res, "/v1/chat/completions", req.body, {
      userId,
      planTier,
      quotaCost: quotaInfo.quotaCost,
      modelId
    });
  })
);

router.post(
  "/responses",
  asyncHandler(async (req, res) => {
    if (!requireModel(req, res)) return;
    const userId = typeof res.locals.userId === "string" ? res.locals.userId : "";
    const planTier = getPlanTierOrDefault(res.locals.planTier);
    const modelId = resolveChargeModel(req.path, req.body);
    const quotaInfo = reserveInferenceQuota(res, modelId);
    if (!quotaInfo) return;

    await proxyJsonRequest(req, res, "/v1/responses", req.body, {
      userId,
      planTier,
      quotaCost: quotaInfo.quotaCost,
      modelId
    });
  })
);

router.post(
  "/default/chat/completions",
  asyncHandler(async (req, res) => {
    const payload = defaultChatPayload(req.body);
    const userId = typeof res.locals.userId === "string" ? res.locals.userId : "";
    const planTier = getPlanTierOrDefault(res.locals.planTier);
    const modelId = resolveChargeModel(req.path, payload);
    const quotaInfo = reserveInferenceQuota(res, modelId);
    if (!quotaInfo) return;

    await proxyJsonRequest(req, res, "/v1/chat/completions", payload, {
      userId,
      planTier,
      quotaCost: quotaInfo.quotaCost,
      modelId
    });
  })
);

router.post(
  "/default/responses",
  asyncHandler(async (req, res) => {
    const payload = defaultResponsesPayload(req.body);
    const userId = typeof res.locals.userId === "string" ? res.locals.userId : "";
    const planTier = getPlanTierOrDefault(res.locals.planTier);
    const modelId = resolveChargeModel(req.path, payload);
    const quotaInfo = reserveInferenceQuota(res, modelId);
    if (!quotaInfo) return;

    await proxyJsonRequest(req, res, "/v1/responses", payload, {
      userId,
      planTier,
      quotaCost: quotaInfo.quotaCost,
      modelId
    });
  })
);

export { router as aiRouter };
