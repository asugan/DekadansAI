import { type Request, type RequestHandler } from "express";
import rateLimit from "express-rate-limit";

import { config } from "../config";

function readBearerToken(authorizationHeader: string): string {
  const lower = authorizationHeader.toLowerCase();
  if (!lower.startsWith("bearer ")) {
    return "";
  }

  return authorizationHeader.slice(7).trim();
}

function buildClientKey(req: Request): string {
  const apiKey = req.header("x-api-key")?.trim();
  if (apiKey) return `key:${apiKey}`;

  const authHeader = req.header("authorization") || "";
  const bearerToken = readBearerToken(authHeader);
  if (bearerToken) return `bearer:${bearerToken}`;

  return `ip:${req.ip || "unknown"}`;
}

function createRateLimiter(max: number, bucket: string): RequestHandler {
  if (max <= 0) {
    return (_req, _res, next) => {
      next();
    };
  }

  return rateLimit({
    windowMs: config.rateLimitWindowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: buildClientKey,
    handler: (_req, res) => {
      res.status(429).json({
        error: "rate_limit_exceeded",
        bucket,
        max,
        windowMs: config.rateLimitWindowMs
      });
    }
  });
}

export const aiRateLimiter = createRateLimiter(config.rateLimitAiMax, "ai-default");
export const codex53RateLimiter = createRateLimiter(config.rateLimitCodex53Max, "ai-codex-5.3");
