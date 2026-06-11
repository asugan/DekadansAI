import { config } from "../config";
import { decodeResponse, requestInference } from "../services/cliproxy-client";

type JsonObject = Record<string, unknown>;

export interface GatewayModel {
  id: string;
  name: string;
  provider: string | null;
  enabled: boolean;
  requestCost: number;
}

function asObject(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }

  return {};
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }

  return fallback;
}

function humanizeModelName(id: string): string {
  return id
    .split(/[-_:./]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function providerFromModel(model: JsonObject, id: string): string | null {
  const provider = model.provider || model.owned_by || model.owner;
  if (typeof provider === "string" && provider.trim()) {
    return provider;
  }

  const [prefix] = id.split(/[-_:./]+/);
  return prefix ? prefix.toLowerCase() : null;
}

function requestCostForModel(id: string): number {
  return config.modelRequestCosts[id] || config.defaultModelRequestCost;
}

export function normalizeModels(payload: unknown): GatewayModel[] {
  const root = asObject(payload);
  const rawModels = Array.isArray(root.data)
    ? root.data
    : Array.isArray(root.models)
      ? root.models
      : Array.isArray(payload)
        ? payload
        : [];

  const models = rawModels
    .map((entry): GatewayModel | null => {
      if (typeof entry === "string") {
        return {
          id: entry,
          name: humanizeModelName(entry),
          provider: providerFromModel({}, entry),
          enabled: true,
          requestCost: requestCostForModel(entry)
        } satisfies GatewayModel;
      }

      const model = asObject(entry);
      const idValue = model.id || model.name || model.model;
      const id = typeof idValue === "string" ? idValue.trim() : "";
      if (!id) return null;

      const nameValue = model.displayName || model.display_name || model.label || model.name;
      const enabled = toBoolean(model.enabled ?? model.active ?? model.available, true);

      if (!enabled) return null;

      return {
        id,
        name: typeof nameValue === "string" && nameValue.trim() ? nameValue : humanizeModelName(id),
        provider: providerFromModel(model, id),
        enabled,
        requestCost: requestCostForModel(id)
      } satisfies GatewayModel;
    })
    .filter((entry): entry is GatewayModel => entry !== null);

  return models.sort((a, b) => a.name.localeCompare(b.name));
}

export async function fetchModelCatalog(): Promise<{
  status: number;
  ok: boolean;
  payload: unknown;
  models: GatewayModel[];
}> {
  const upstreamResponse = await requestInference({ method: "GET", pathname: "/v1/models" });
  const payload = await decodeResponse(upstreamResponse);

  return {
    status: upstreamResponse.status,
    ok: upstreamResponse.ok,
    payload,
    models: upstreamResponse.ok ? normalizeModels(payload) : []
  };
}
