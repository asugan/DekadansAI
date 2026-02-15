import path from "node:path";

import dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

function toInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export interface AppConfig {
  port: number;
  appApiKey: string;
  corsOrigin: string;
  cliProxyBaseUrl: string;
  cliProxyManagementKey: string;
  cliProxyApiKey: string;
  requestTimeoutMs: number;
}

export const config: AppConfig = {
  port: toInt(process.env.PORT, 3000),
  appApiKey: process.env.APP_API_KEY || "",
  corsOrigin: process.env.CORS_ORIGIN || "*",
  cliProxyBaseUrl: (process.env.CLI_PROXY_BASE_URL || "http://127.0.0.1:8317").replace(/\/$/, ""),
  cliProxyManagementKey: process.env.CLI_PROXY_MANAGEMENT_KEY || "",
  cliProxyApiKey: process.env.CLI_PROXY_API_KEY || "",
  requestTimeoutMs: toInt(process.env.REQUEST_TIMEOUT_MS, 120000)
};

export function assertRequiredConfig(): void {
  const missing: string[] = [];

  if (!config.cliProxyManagementKey) missing.push("CLI_PROXY_MANAGEMENT_KEY");
  if (!config.cliProxyApiKey) missing.push("CLI_PROXY_API_KEY");

  if (missing.length > 0) {
    throw new Error(`Missing required env values: ${missing.join(", ")}`);
  }
}
