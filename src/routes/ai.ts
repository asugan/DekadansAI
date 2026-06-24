import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type ReadableStream } from "node:stream/web";

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
import { decodeResponse, requestInference } from "../services/cliproxy-client";

const v1Router = express.Router();

type JsonObject = Record<string, unknown>;
type UsageEventType = "inference" | "token_count";

interface UsageRecordInfo {
  userId: string;
  apiKeyId: string | null;
  modelId: string;
  requestCost: number;
  eventType: UsageEventType;
  billable: boolean;
}

interface ProxyJsonOptions {
  quotaInfo?: { userId: string; planTier: PlanTierConfig; quotaCost: number; modelId: string };
  usageInfo?: UsageRecordInfo;
}

function asObject(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }

  return {};
}

function getRequestedModel(body: unknown): string {
  const payload = asObject(body);
  return typeof payload.model === "string" ? payload.model.trim() : "";
}

export function resolveChargeModel(_reqPath: string, payload: unknown): string {
  return getRequestedModel(payload);
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

function getUserIdOrReject(res: Response): string | null {
  const userId = typeof res.locals.userId === "string" ? res.locals.userId : "";

  if (!userId) {
    res.status(401).json({ error: "unauthorized" });
    return null;
  }

  return userId;
}

function buildInferenceUsageInfo(res: Response, quotaInfo: {
  userId: string;
  quotaCost: number;
  modelId: string;
}): UsageRecordInfo {
  return {
    userId: quotaInfo.userId,
    apiKeyId: typeof res.locals.apiKeyId === "string" ? res.locals.apiKeyId : null,
    modelId: quotaInfo.modelId,
    requestCost: quotaInfo.quotaCost,
    eventType: "inference",
    billable: true
  };
}

function extractStreamingUsageFromPayload(payload: unknown): ReturnType<typeof extractTokenUsage> {
  const root = asObject(payload);
  const message = asObject(root.message);
  const usageSource = Object.keys(asObject(root.usage)).length > 0 ? root : message;

  return extractTokenUsage(usageSource);
}

function mergeUsage(
  current: ReturnType<typeof extractTokenUsage>,
  next: ReturnType<typeof extractTokenUsage>
): ReturnType<typeof extractTokenUsage> {
  const inputTokens = Math.max(current.inputTokens, next.inputTokens);
  const outputTokens = Math.max(current.outputTokens, next.outputTokens);

  return {
    inputTokens,
    outputTokens,
    totalTokens: Math.max(current.totalTokens, next.totalTokens, inputTokens + outputTokens)
  };
}

function createUsageTap(onUsage: (usage: ReturnType<typeof extractTokenUsage>) => void): Transform {
  let buffer = "";
  let streamingUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  function parseLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;

    const rawData = trimmed.slice(5).trim();
    if (!rawData || rawData === "[DONE]") return;

    try {
      streamingUsage = mergeUsage(streamingUsage, extractStreamingUsageFromPayload(JSON.parse(rawData)));
      onUsage(streamingUsage);
    } catch {
      // Ignore non-JSON SSE frames while preserving the response stream.
    }
  }

  return new Transform({
    transform(chunk, _encoding, callback) {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";

      for (const line of lines) {
        parseLine(line);
      }

      callback(null, chunk);
    },
    flush(callback) {
      if (buffer) {
        parseLine(buffer);
      }
      callback();
    }
  });
}

async function pipeStreamingResponseWithUsage(
  upstreamResponse: globalThis.Response,
  res: Response,
  usageInfo: UsageRecordInfo | undefined,
  endpoint: string
): Promise<void> {
  const contentType = upstreamResponse.headers.get("content-type");
  const cacheControl = upstreamResponse.headers.get("cache-control");
  let streamingUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  res.status(upstreamResponse.status);
  if (contentType) res.setHeader("content-type", contentType);
  if (cacheControl) res.setHeader("cache-control", cacheControl);

  if (!upstreamResponse.body) {
    res.end();
  } else {
    const body = Readable.fromWeb(upstreamResponse.body as unknown as ReadableStream<Uint8Array>);
    const tap = createUsageTap((usage) => {
      streamingUsage = usage;
    });

    await pipeline(body, tap, res);
  }

  if (usageInfo && upstreamResponse.status < 500) {
    recordUsageEvent({
      userId: usageInfo.userId,
      apiKeyId: usageInfo.apiKeyId,
      model: usageInfo.modelId || null,
      endpoint,
      statusCode: upstreamResponse.status,
      requestCost: usageInfo.requestCost,
      eventType: usageInfo.eventType,
      billable: usageInfo.billable,
      ...streamingUsage
    });
  }
}

async function proxyJsonRequest(
  req: Request,
  res: Response,
  pathname: string,
  payload: unknown = req.body,
  options: ProxyJsonOptions = {}
): Promise<void> {
  const { quotaInfo, usageInfo } = options;
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
    await pipeStreamingResponseWithUsage(upstreamResponse, res, usageInfo, pathname);
    return;
  }

  const responsePayload = await decodeResponse(upstreamResponse);
  if (usageInfo && upstreamResponse.status < 500) {
    const usage = extractTokenUsage(responsePayload);

    recordUsageEvent({
      userId: usageInfo.userId,
      apiKeyId: usageInfo.apiKeyId,
      model: usageInfo.modelId || null,
      endpoint: pathname,
      statusCode: upstreamResponse.status,
      requestCost: usageInfo.requestCost,
      eventType: usageInfo.eventType,
      billable: usageInfo.billable,
      ...usage
    });
  }
  res.status(upstreamResponse.status).json(responsePayload || {});
}

const handleModels = asyncHandler(async (_req, res) => {
  const upstreamResponse = await requestInference({ method: "GET", pathname: "/v1/models" });
  const payload = await decodeResponse(upstreamResponse);
  res.status(upstreamResponse.status).json(sanitizePublicModelPayload(payload || {}));
});

const handleChatCompletions = asyncHandler(async (req, res) => {
  if (!requireModel(req, res)) return;
  const userId = typeof res.locals.userId === "string" ? res.locals.userId : "";
  const planTier = getPlanTierOrDefault(res.locals.planTier);
  const modelId = resolveChargeModel(req.path, req.body);
  const quotaInfo = reserveInferenceQuota(res, modelId);
  if (!quotaInfo) return;

  await proxyJsonRequest(req, res, "/v1/chat/completions", req.body, {
    quotaInfo: {
      userId,
      planTier,
      quotaCost: quotaInfo.quotaCost,
      modelId
    },
    usageInfo: buildInferenceUsageInfo(res, { userId, quotaCost: quotaInfo.quotaCost, modelId })
  });
});

const handleResponses = asyncHandler(async (req, res) => {
  if (!requireModel(req, res)) return;
  const userId = typeof res.locals.userId === "string" ? res.locals.userId : "";
  const planTier = getPlanTierOrDefault(res.locals.planTier);
  const modelId = resolveChargeModel(req.path, req.body);
  const quotaInfo = reserveInferenceQuota(res, modelId);
  if (!quotaInfo) return;

  await proxyJsonRequest(req, res, "/v1/responses", req.body, {
    quotaInfo: {
      userId,
      planTier,
      quotaCost: quotaInfo.quotaCost,
      modelId
    },
    usageInfo: buildInferenceUsageInfo(res, { userId, quotaCost: quotaInfo.quotaCost, modelId })
  });
});

const handleMessages = asyncHandler(async (req, res) => {
  if (!requireModel(req, res)) return;
  const userId = typeof res.locals.userId === "string" ? res.locals.userId : "";
  const planTier = getPlanTierOrDefault(res.locals.planTier);
  const modelId = resolveChargeModel(req.path, req.body);
  const quotaInfo = reserveInferenceQuota(res, modelId);
  if (!quotaInfo) return;

  await proxyJsonRequest(req, res, "/v1/messages", req.body, {
    quotaInfo: {
      userId,
      planTier,
      quotaCost: quotaInfo.quotaCost,
      modelId
    },
    usageInfo: buildInferenceUsageInfo(res, { userId, quotaCost: quotaInfo.quotaCost, modelId })
  });
});

const handleMessageTokenCount = asyncHandler(async (req, res) => {
  if (!requireModel(req, res)) return;
  const userId = getUserIdOrReject(res);
  if (!userId) return;
  const modelId = resolveChargeModel(req.path, req.body);

  await proxyJsonRequest(req, res, "/v1/messages/count_tokens", req.body, {
    usageInfo: {
      userId,
      apiKeyId: typeof res.locals.apiKeyId === "string" ? res.locals.apiKeyId : null,
      modelId,
      requestCost: 0,
      eventType: "token_count",
      billable: false
    }
  });
});

v1Router.get("/models", handleModels);
v1Router.post("/chat/completions", handleChatCompletions);
v1Router.post("/responses", handleResponses);
v1Router.post("/messages", handleMessages);
v1Router.post("/messages/count_tokens", handleMessageTokenCount);

export { v1Router };
