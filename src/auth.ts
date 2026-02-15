import fs from "node:fs";
import path from "node:path";

import { betterAuth } from "better-auth";
import { apiKey } from "better-auth/plugins";
import Database from "better-sqlite3";

import { config } from "./config";

const databasePath = path.resolve(process.cwd(), config.betterAuthDatabasePath);
fs.mkdirSync(path.dirname(databasePath), { recursive: true });

const database = new Database(databasePath);

export const auth = betterAuth({
  database,
  secret: config.betterAuthSecret,
  baseURL: config.betterAuthUrl,
  emailAndPassword: {
    enabled: true,
    autoSignIn: true
  },
  plugins: [
    apiKey({
      defaultPrefix: config.apiKeyPrefix,
      enableSessionForAPIKeys: true,
      rateLimit: {
        enabled: true,
        timeWindow: config.apiKeyRateLimitWindowMs,
        maxRequests: config.apiKeyRateLimitMax
      }
    })
  ]
});
