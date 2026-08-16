/**
 * The deployment's model catalog (catalog.ts): `ModelCatalogApi` for a
 * thread DO — the shared construction (`createModelCatalog` in the
 * worker package) with the auth source resolved from the deployment's
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

import { createModelCatalog } from "@saku/worker/isolate";
import type { AuthContext } from "@earendil-works/pi-ai";

import type { DeploymentEnv, DeploymentVars } from "./env.ts";
import { isNonEmptyString } from "./env.ts";

/** The vars pi can probe by name; mirrors `DeploymentVars` (auth needs the names at runtime). */
const DEPLOYMENT_VARS = [
  "SAKU_ENV_PROVISIONER",
  "SAKU_ENV_URL",
  "SAKU_ENV_TOKEN",
  "SAKU_IDLE_STOP_MS",
  "SAKU_FAKE_MODEL",
] as const satisfies readonly (keyof DeploymentVars)[];

/** pi's builtin providers read their env vars through the auth context. */
const deploymentAuthContext = (env: DeploymentEnv): AuthContext => ({
  env: async (name) => {
    const key = DEPLOYMENT_VARS.find((varName) => varName === name);
    const value = key === undefined ? undefined : env[key];
    return await Promise.resolve(isNonEmptyString(value) ? value : undefined);
  },
  // No filesystem in a DO: file probes answer "no" (the default context's
  // node:fs import also fails soft there — this is the honest answer).
  fileExists: async () => await Promise.resolve(false),
});

/** Build the thread DO's catalog from the deployment's bindings. */
export const deploymentCatalog = (env: DeploymentEnv) =>
  createModelCatalog({
    auth: { authContext: deploymentAuthContext(env) },
    env,
  });
