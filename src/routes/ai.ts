import express, { type Request, type Response } from "express";

import { config } from "../config";
import { asyncHandler } from "../lib/async-handler";
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
  payload: unknown = req.body
): Promise<void> {
  const upstreamResponse = await requestInference({
    method: req.method,
    pathname,
    body: payload
  });

  const contentType = upstreamResponse.headers.get("content-type") || "";
  const bodyAsObject = asObject(payload);
  const isStreaming = bodyAsObject.stream === true || contentType.includes("text/event-stream");

  if (isStreaming) {
    await pipeUpstreamResponse(upstreamResponse, res);
    return;
  }

  const responsePayload = await decodeResponse(upstreamResponse);
  res.status(upstreamResponse.status).json(responsePayload || {});
}

router.get(
  "/models",
  asyncHandler(async (_req, res) => {
    const upstreamResponse = await requestInference({ method: "GET", pathname: "/v1/models" });
    const payload = await decodeResponse(upstreamResponse);
    res.status(upstreamResponse.status).json(payload || {});
  })
);

router.post(
  "/chat/completions",
  asyncHandler(async (req, res) => {
    if (!requireModel(req, res)) return;
    await proxyJsonRequest(req, res, "/v1/chat/completions");
  })
);

router.post(
  "/responses",
  asyncHandler(async (req, res) => {
    if (!requireModel(req, res)) return;
    await proxyJsonRequest(req, res, "/v1/responses");
  })
);

router.post(
  "/default/chat/completions",
  asyncHandler(async (req, res) => {
    const payload = defaultChatPayload(req.body);
    await proxyJsonRequest(req, res, "/v1/chat/completions", payload);
  })
);

router.post(
  "/default/responses",
  asyncHandler(async (req, res) => {
    const payload = defaultResponsesPayload(req.body);
    await proxyJsonRequest(req, res, "/v1/responses", payload);
  })
);

export { router as aiRouter };
