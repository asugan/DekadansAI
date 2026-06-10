import fs from "node:fs";
import path from "node:path";

import { checkout, polar, portal, webhooks } from "@polar-sh/better-auth";
import { betterAuth } from "better-auth";
import { apiKey } from "better-auth/plugins";
import Database from "better-sqlite3";

import { config } from "./config";
import { polarClient } from "./lib/polar";

const databasePath = path.resolve(process.cwd(), config.betterAuthDatabasePath);
fs.mkdirSync(path.dirname(databasePath), { recursive: true });

const database = new Database(databasePath);

export const auth = betterAuth({
  database,
  secret: config.betterAuthSecret,
  baseURL: config.betterAuthUrl,
  trustedOrigins: config.betterAuthTrustedOrigins,
  emailAndPassword: {
    enabled: true,
    autoSignIn: true
  },
  plugins: [
    polar({
      client: polarClient,
      createCustomerOnSignUp: true,
      use: [
        checkout({
          products: [
            {
              productId: config.polarWeeklyProductId,
              slug: "weekly"
            }
          ],
          successUrl: config.polarCheckoutSuccessUrl,
          returnUrl: config.polarPortalReturnUrl,
          authenticatedUsersOnly: true
        }),
        portal({
          returnUrl: config.polarPortalReturnUrl
        }),
        webhooks({
          secret: config.polarWebhookSecret
        })
      ]
    }),
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
