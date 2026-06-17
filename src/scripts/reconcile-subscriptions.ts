import { assertRequiredConfig } from "../config";
import { reconcileSubscriptionEntitlements } from "../lib/subscription-entitlements";

async function main(): Promise<void> {
  assertRequiredConfig();
  const result = await reconcileSubscriptionEntitlements();
  console.info(
    `Subscription reconciliation checked=${result.checked} synced=${result.synced} missing=${result.missing} failed=${result.failed}`
  );

  if (result.failed > 0) {
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  console.error("Subscription reconciliation crashed", error);
  process.exitCode = 1;
});
