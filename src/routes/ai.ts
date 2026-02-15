import express, { type Request, type Response } from "express";

import { asyncHandler } from "../lib/async-handler";
import {
  decodeResponse,
  requestInference,
  pipeUpstreamResponse
} from "../services/cliproxy-client";

const router = express.Router();

async function proxyJsonRequest(req: Request, res: Response, pathname: string): Promise<void> {
  const upstreamResponse = await requestInference({
    method: req.method,
    pathname,
    body: req.body
  });

  const contentType = upstreamResponse.headers.get("content-type") || "";
  const isStreaming = req.body?.stream === true || contentType.includes("text/event-stream");

  if (isStreaming) {
    await pipeUpstreamResponse(upstreamResponse, res);
    return;
  }

  const payload = await decodeResponse(upstreamResponse);
  res.status(upstreamResponse.status).json(payload || {});
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
    await proxyJsonRequest(req, res, "/v1/chat/completions");
  })
);

router.post(
  "/responses",
  asyncHandler(async (req, res) => {
    await proxyJsonRequest(req, res, "/v1/responses");
  })
);

export { router as aiRouter };
