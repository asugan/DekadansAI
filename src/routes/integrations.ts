import express from "express";

import { asyncHandler } from "../lib/async-handler";
import { HttpError } from "../lib/errors";
import { requestManagement } from "../services/cliproxy-client";

const router = express.Router();

const PROVIDER_AUTH_ENDPOINTS = {
  codex: "/v0/management/codex-auth-url",
  claude: "/v0/management/anthropic-auth-url",
  anthropic: "/v0/management/anthropic-auth-url",
  gemini: "/v0/management/gemini-cli-auth-url",
  "gemini-cli": "/v0/management/gemini-cli-auth-url",
  antigravity: "/v0/management/antigravity-auth-url",
  qwen: "/v0/management/qwen-auth-url",
  iflow: "/v0/management/iflow-auth-url"
} as const;

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  if (value && typeof value === "object") {
    return value as JsonObject;
  }

  return {};
}

router.get("/providers", (_req, res) => {
  res.json({ providers: Object.keys(PROVIDER_AUTH_ENDPOINTS) });
});

router.post(
  "/:provider/connect/start",
  asyncHandler(async (req, res) => {
    const provider = String(req.params.provider || "").toLowerCase();
    const endpoint = PROVIDER_AUTH_ENDPOINTS[provider as keyof typeof PROVIDER_AUTH_ENDPOINTS];

    if (!endpoint) {
      throw new HttpError("unsupported provider", 400, {
        providers: Object.keys(PROVIDER_AUTH_ENDPOINTS)
      });
    }

    const query: Record<string, string | boolean> = {};
    if (req.body?.isWebUi === true) query.is_webui = true;
    if ((provider === "gemini" || provider === "gemini-cli") && req.body?.projectId) {
      query.project_id = String(req.body.projectId);
    }

    const data = await requestManagement({ pathname: endpoint, query });
    const payload = asObject(data);

    res.json({
      provider,
      status: typeof payload.status === "string" ? payload.status : "ok",
      authUrl: typeof payload.url === "string" ? payload.url : null,
      state: typeof payload.state === "string" ? payload.state : null,
      raw: data
    });
  })
);

router.get(
  "/connect/status",
  asyncHandler(async (req, res) => {
    const state = String(req.query.state || "").trim();
    if (!state) {
      throw new HttpError("state is required", 400);
    }

    const data = await requestManagement({
      pathname: "/v0/management/get-auth-status",
      query: { state }
    });

    res.json(data || { status: "wait" });
  })
);

router.get(
  "/accounts",
  asyncHandler(async (req, res) => {
    const provider = String(req.query.provider || "").toLowerCase();
    const data = await requestManagement({ pathname: "/v0/management/auth-files" });
    const payload = asObject(data);
    const sourceFiles = Array.isArray(payload.files) ? payload.files : [];

    const files = provider
      ? sourceFiles.filter((file) => {
          const item = asObject(file);
          return String(item.provider || "").toLowerCase() === provider;
        })
      : sourceFiles;

    res.json({ count: files.length, files });
  })
);

router.delete(
  "/accounts/:name",
  asyncHandler(async (req, res) => {
    const name = String(req.params.name || "").trim();
    if (!name) {
      throw new HttpError("account name is required", 400);
    }

    const data = await requestManagement({
      method: "DELETE",
      pathname: "/v0/management/auth-files",
      query: { name }
    });

    res.json(data || { status: "ok" });
  })
);

router.post(
  "/iflow/connect/cookie",
  asyncHandler(async (req, res) => {
    const cookie = String(req.body?.cookie || "").trim();
    if (!cookie) {
      throw new HttpError("cookie is required", 400);
    }

    const data = await requestManagement({
      method: "POST",
      pathname: "/v0/management/iflow-auth-url",
      body: { cookie }
    });

    res.json(data);
  })
);

export { router as integrationsRouter };
