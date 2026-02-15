import { Readable } from "node:stream";
import { type ReadableStream } from "node:stream/web";

import { type Response as ExpressResponse } from "express";

import { config } from "../config";
import { HttpError } from "../lib/errors";

type QueryParams = Record<string, string | number | boolean | null | undefined>;

interface ManagementRequest {
  method?: string;
  pathname: string;
  query?: QueryParams;
  body?: unknown;
}

interface InferenceRequest {
  method?: string;
  pathname: string;
  body?: unknown;
}

function buildUrl(pathname: string, query: QueryParams = {}): URL {
  const url = new URL(pathname, `${config.cliProxyBaseUrl}/`);

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }

  return url;
}

export async function decodeResponse(response: globalThis.Response): Promise<unknown | null> {
  const contentType = response.headers.get("content-type") || "";
  const raw = await response.text();

  if (!raw) {
    return null;
  }

  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(raw);
    } catch {
      return { raw };
    }
  }

  return { raw };
}

export async function requestManagement({
  method = "GET",
  pathname,
  query,
  body
}: ManagementRequest): Promise<unknown> {
  const url = buildUrl(pathname, query);
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${config.cliProxyManagementKey}`,
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(config.requestTimeoutMs)
  });

  const data = await decodeResponse(response);

  if (!response.ok) {
    throw new HttpError("CLIProxyAPI management request failed", response.status, data);
  }

  return data;
}

export async function requestInference({
  method = "POST",
  pathname,
  body
}: InferenceRequest): Promise<globalThis.Response> {
  const url = buildUrl(pathname);

  return fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${config.cliProxyApiKey}`,
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(config.requestTimeoutMs)
  });
}

export async function pipeUpstreamResponse(
  upstreamResponse: globalThis.Response,
  res: ExpressResponse
): Promise<void> {
  const contentType = upstreamResponse.headers.get("content-type");
  const cacheControl = upstreamResponse.headers.get("cache-control");

  res.status(upstreamResponse.status);
  if (contentType) res.setHeader("content-type", contentType);
  if (cacheControl) res.setHeader("cache-control", cacheControl);

  if (!upstreamResponse.body) {
    res.end();
    return;
  }

  Readable.fromWeb(upstreamResponse.body as unknown as ReadableStream<Uint8Array>).pipe(res);
}
