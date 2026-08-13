/**
 * The deployment's model catalog (catalog.ts): `ModelCatalogShape` for a
 * thread DO — the shared construction (`createModelCatalog` in
 * @saku/worker) with the auth source resolved from the deployment's
 * bindings. This module is a thin binding-reader: the provider
 * registration, the `SAKU_FAKE_MODEL` scripted fixture, and the shape
 * live in exactly one place (worker/model-catalog-factory.ts).
 *
 * The opencode-go provider reads its env var (`OPENCODE_API_KEY`)
 * through an `AuthContext` whose `env` reads the DO's bindings (the
 * default context reads `process.env`, which does not exist in a DO).
 * openai/anthropic/gemini and the other builtin providers are
 * deliberately not registered.
 *
 * No models.json in a DO (no filesystem): custom providers, overlays,
 * and `!command` values are local-spine concerns. The scripted provider
 * behind `SAKU_FAKE_MODEL` is a real provider whose stream answers with
 * canned assistant messages, for dev deployments and the integration
 * tests (no LLM key required).
 */

import { createModelCatalog, type ModelCatalogShape } from "@saku/worker/isolate";
import type { AuthContext } from "@earendil-works/pi-ai";

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

/** Build the thread DO's catalog from the deployment's bindings. */
export const deploymentCatalog = (env: DeploymentEnv): ModelCatalogShape =>
  createModelCatalog({
    auth: { authContext: deploymentAuthContext(env) },
    env,
  });
