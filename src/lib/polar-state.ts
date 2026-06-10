import { config } from "../config";

type JsonObject = Record<string, unknown>;

export interface WeeklyPlanStatus {
  active: boolean;
  customerExists: boolean;
}

export function asObject(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }

  return {};
}

export function isPolarNotFound(error: unknown): boolean {
  const errorAsObject = asObject(error);
  const status = Number(errorAsObject.statusCode || errorAsObject.status || 0);
  const body = typeof errorAsObject.body === "string" ? errorAsObject.body : "";
  const message = error instanceof Error ? error.message : "";

  return status === 404 || body.includes("ResourceNotFound") || message.includes("ResourceNotFound");
}

export function getActiveSubscriptions(customerState: unknown): JsonObject[] {
  const state = asObject(customerState);
  const subscriptions = state.active_subscriptions || state.activeSubscriptions;

  if (!Array.isArray(subscriptions)) {
    return [];
  }

  return subscriptions.map(asObject);
}

export function getWeeklyPlanStatus(customerState: unknown): WeeklyPlanStatus {
  const active = getActiveSubscriptions(customerState).some((subscription) => {
    const productId = subscription.product_id || subscription.productId;
    return productId === config.polarWeeklyProductId;
  });

  return {
    active,
    customerExists: true
  };
}
