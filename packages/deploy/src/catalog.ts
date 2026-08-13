/**
 * The deployment's model catalog (catalog.ts): `ModelCatalogShape` for a
 * thread DO — the opencode-go provider (the local OpenCode gateway, the
 * only builtin provider saku registers) with its auth resolved from the
 * deployment's bindings.
 *
 * The provider reads its env var (`OPENCODE_API_KEY`) through an
 * `AuthContext` whose `env` reads the DO's bindings (the default context
 * reads `process.env`, which does not exist in a DO). openai/anthropic/
 * gemini and the other builtin providers are deliberately not registered.
 *
 * No models.json in a DO (no filesystem): custom providers, overlays,
 * and `!command` values are local-spine concerns. The one addition is
 * the scripted provider behind `SAKU_FAKE_MODEL` — a real provider whose
 * stream answers with canned assistant messages, for dev deployments and
 * the integration tests (no LLM key required).
 */

import * as Effect from "effect/Effect";
import { createModels, type AuthContext } from "@earendil-works/pi-ai";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import type { ModelCatalogShape } from "@saku/worker/isolate";
import { fakeProvider } from "@saku/worker/fake-provider";

import type { DeploymentEnv } from "./env.ts";

/** pi's builtin providers read their env vars through the auth context. */
const deploymentAuthContext = (env: DeploymentEnv): AuthContext => ({
  env: async (name) => {
    const value = (env as unknown as Record<string, unknown>)[name];
    return typeof value === "string" && value.trim().length > 0 ? value : undefined;
  },
  // No filesystem in a DO: file probes answer "no" (the default context's
  // node:fs import also fails soft there — this is the honest answer).
  fileExists: async () => false,
});

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

/** Build the thread DO's catalog from the deployment's bindings. */
export const deploymentCatalog = (env: DeploymentEnv): ModelCatalogShape => {
  const models = createModels({ authContext: deploymentAuthContext(env) });
  models.setProvider(opencodeGoProvider());
  if ((env.SAKU_FAKE_MODEL ?? "").length > 0) {
    models.setProvider(fakeProvider());
  }
  return {
    models,
    available: () => Effect.tryPromise(() => models.getAvailable()),
    hasAuth: (providerId) =>
      Effect.tryPromise(() => models.checkAuth(providerId))
        .pipe(Effect.map((check) => check !== undefined))
        .pipe(Effect.catchEager(() => Effect.succeed(false))),
    getModel: (providerId, modelId) => models.getModel(providerId, modelId),
    toWireInfo: (model) => ({
      provider: model.provider,
      id: model.id,
      contextWindow: model.contextWindow,
      reasoning: model.reasoning,
    }),
  };
};
