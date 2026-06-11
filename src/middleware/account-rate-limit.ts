import { type RequestHandler } from "express";

import { config } from "../config";
import { consumeAccountRateLimit, getModelRequestCost } from "../lib/account-rate-limit";

function getRequestedModel(reqPath: string, body: unknown): string {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const model = (body as { model?: unknown }).model;
    if (typeof model === "string" && model.trim()) {
      return model.trim();
    }
  }

  return reqPath.startsWith("/default/") ? config.defaultModel : "";
}

export const accountRateLimitMiddleware: RequestHandler = (req, res, next) => {
  const userId = typeof res.locals.userId === "string" ? res.locals.userId : "";

  if (!userId) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const model = getRequestedModel(req.path, req.body);
  const result = consumeAccountRateLimit(userId, model ? getModelRequestCost(model) : undefined);

  res.setHeader("RateLimit-Limit", String(result.snapshot.quota.max));
  res.setHeader("RateLimit-Remaining", String(result.snapshot.quota.remaining));
  res.setHeader("X-RateLimit-Request-Cost", String(result.quotaCost));
  res.setHeader(
    "RateLimit-Reset",
    String(Math.ceil(new Date(result.snapshot.quota.resetAt).getTime() / 1000))
  );

  if (!result.allowed) {
    if (result.retryAfterMs > 0) {
      res.setHeader("Retry-After", String(Math.ceil(result.retryAfterMs / 1000)));
    }

    return res.status(429).json({
      error: "account_rate_limit_exceeded",
      reason: result.reason,
      retryAfterMs: result.retryAfterMs,
      requestCost: result.quotaCost,
      quota: result.snapshot.quota,
      burst: result.snapshot.burst
    });
  }

  res.locals.accountRateLimit = result.snapshot;
  return next();
};
