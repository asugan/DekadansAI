import { fromNodeHeaders } from "better-auth/node";
import { type RequestHandler } from "express";

import { auth } from "../auth";

function getApiKeyFromRequestHeader(headerValue: string | undefined): string {
  if (!headerValue) {
    return "";
  }

  if (headerValue.toLowerCase().startsWith("bearer ")) {
    return headerValue.slice(7).trim();
  }

  return "";
}

export const authMiddleware: RequestHandler = (req, res, next) => {
  const xApiKey = req.header("x-api-key")?.trim() || "";
  const bearerKey = getApiKeyFromRequestHeader(req.header("authorization") || undefined);
  const apiKey = xApiKey || bearerKey;

  if (!apiKey) {
    return res.status(401).json({ error: "missing_api_key" });
  }

  void (async () => {
    try {
      const headers = fromNodeHeaders(req.headers);
      headers.set("x-api-key", apiKey);

      const session = await auth.api.getSession({ headers });

      if (!session?.user) {
        return res.status(401).json({ error: "invalid_api_key" });
      }

      return next();
    } catch (error) {
      const errorAsObject = error as {
        status?: number;
        statusCode?: number;
        code?: string;
        body?: { code?: string; message?: string };
      };

      const status = Number(errorAsObject.status || errorAsObject.statusCode || 500);
      const code = errorAsObject.code || errorAsObject.body?.code || "";
      const message =
        (error instanceof Error ? error.message : "") || errorAsObject.body?.message || "";

      if (status === 429 || code === "RATE_LIMITED" || /rate limit/i.test(message)) {
        return res.status(429).json({ error: "rate_limit_exceeded" });
      }

      if (status === 401) {
        return res.status(401).json({ error: "invalid_api_key" });
      }

      return next(error);
    }
  })();
};
