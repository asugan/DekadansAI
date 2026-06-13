import { checkout, polar, portal, webhooks } from "@polar-sh/better-auth";
import { betterAuth } from "better-auth";
import { apiKey } from "better-auth/plugins";

import { config } from "./config";
import { database } from "./lib/database";
import { polarClient } from "./lib/polar";

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
          products: config.planTiers.map((tier) => ({
            productId: tier.productId,
            slug: tier.slug
          })),
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
        enabled: false
      }
    })
  ]
});
