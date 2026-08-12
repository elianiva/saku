/**
 * The deployment's model catalog (catalog.ts): `ModelCatalogShape` for a
 * thread DO — pi's builtin providers with their auth resolved from the
 * deployment's secrets and vars.
 *
 * pi-ai's providers already declare their own env-var conventions
 * (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, ...); the deployment catalog
 * supplies an `AuthContext` whose `env` reads the DO's bindings (the
 * default context reads `process.env`, which does not exist in a DO), so
 * a key bound as a deployment secret makes its provider available
 * verbatim — same semantics as auth.json under the local daemon.
 *
 * No models.json in a DO (no filesystem): custom providers, overlays,
 * and `!command` values are local-spine concerns. The one addition is
 * the scripted provider behind `SAKU_FAKE_MODEL` — a real provider whose
 * stream answers with canned assistant messages, for dev deployments and
 * the integration tests (no LLM key required).
 */

import * as Effect from "effect/Effect";
import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  type Api,
  type ApiKeyAuth,
  type AssistantMessage,
  type AuthContext,
  type Model,
  type Provider,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { getApiProvider, registerBuiltInApiProviders } from "@earendil-works/pi-ai/compat";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ModelCatalogShape } from "@saku/worker/isolate";

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
// The scripted provider (SAKU_FAKE_MODEL)
// ---------------------------------------------------------------------------

const FAKE_PROVIDER = "saku-fake";
const FAKE_MODEL = "test";

const fakeMessage = (): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text: "Hello from the saku-fake model." }],
  api: "pi-messages",
  provider: FAKE_PROVIDER,
  model: FAKE_MODEL,
  usage: {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: Date.now(),
});

const fakeApiKeyAuth = (): ApiKeyAuth => ({
  name: "API key",
  login: async (interaction) => ({
    type: "api_key" as const,
    key: "fake",
  }),
  check: async () => ({ type: "api_key" as const, source: "configured API key" }),
  resolve: async () => ({ auth: { apiKey: "fake" }, source: "configured API key" }),
});

const fakeProvider = (): Provider => {
  const model: Model<Api> = {
    id: FAKE_MODEL,
    name: "test",
    api: "pi-messages",
    provider: FAKE_PROVIDER,
    baseUrl: "https://fake.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
  const streams: ProviderStreams = {
    stream: () => {
      const stream = createAssistantMessageEventStream();
      stream.end(fakeMessage());
      return stream;
    },
    streamSimple: () => {
      const stream = createAssistantMessageEventStream();
      stream.end(fakeMessage());
      return stream;
    },
  };
  return createProvider({
    id: FAKE_PROVIDER,
    name: "saku-fake",
    baseUrl: "https://fake.invalid",
    auth: { apiKey: fakeApiKeyAuth() },
    models: [model],
    api: streams,
  });
};

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

/** Build the thread DO's catalog from the deployment's bindings. */
export const deploymentCatalog = (env: DeploymentEnv): ModelCatalogShape => {
  registerBuiltInApiProviders();
  const models = createModels({ authContext: deploymentAuthContext(env) });
  for (const provider of builtinProviders()) {
    models.setProvider(provider);
  }
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
