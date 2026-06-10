import { type RequestHandler } from "express";

import { consumeAccountRateLimit } from "../lib/account-rate-limit";

export const accountRateLimitMiddleware: RequestHandler = (_req, res, next) => {
  const userId = typeof res.locals.userId === "string" ? res.locals.userId : "";

  if (!userId) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const result = consumeAccountRateLimit(userId);

  res.setHeader("RateLimit-Limit", String(result.snapshot.quota.max));
  res.setHeader("RateLimit-Remaining", String(result.snapshot.quota.remaining));
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
      quota: result.snapshot.quota,
      burst: result.snapshot.burst
    });
  }

  res.locals.accountRateLimit = result.snapshot;
  return next();
};
