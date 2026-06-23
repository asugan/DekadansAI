import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PUBLIC_PROVIDER_NAME,
  normalizeModels,
  sanitizePublicModelPayload
} from "../lib/model-catalog.js";

void test("normalizeModels masks providers in catalog entries", () => {
  const models = normalizeModels({
    data: [
      { id: "gpt-5.5", provider: "openai" },
      { id: "kimi-k2.6", owned_by: "fireworks" },
      "ollama/custom-model"
    ]
  });

  assert.deepEqual(
    models.map((model) => model.provider),
    [PUBLIC_PROVIDER_NAME, PUBLIC_PROVIDER_NAME, PUBLIC_PROVIDER_NAME]
  );
});

void test("sanitizePublicModelPayload masks upstream provider fields", () => {
  const payload = sanitizePublicModelPayload({
    object: "list",
    data: [{ id: "llama", provider: "ollama", owned_by: "fireworks", owner: "raw" }]
  });

  assert.deepEqual(payload, {
    object: "list",
    data: [
      {
        id: "llama",
        provider: PUBLIC_PROVIDER_NAME,
        owned_by: PUBLIC_PROVIDER_NAME,
        owner: PUBLIC_PROVIDER_NAME
      }
    ]
  });
});
