/**
 * The scripted provider (fake-provider.ts): a canned pi provider behind
 * `SAKU_FAKE_MODEL` — no network, no key. One shared definition for the
 * daemon's catalog (model-catalog.ts) and the deployment's catalog
 * (deploy/src/catalog.ts), so the dev fixture never drifts between hosts.
 *
 * Node-clean (no node: imports): importable from the workerd side of the
 * package, where the module graph must stay isolate-safe.
 */

import {
  createAssistantMessageEventStream,
  createProvider,
  type Api,
  type ApiKeyAuth,
  type AssistantMessage,
  type Model,
  type Provider,
  type ProviderStreams,
} from "@earendil-works/pi-ai";

export const FAKE_PROVIDER = "saku-fake";
export const FAKE_MODEL = "test";

export const fakeText = (): AssistantMessage => ({
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

/** The first answer of a turn asks for a bash tool call; the follow-up is
 * text-only, so a turn ends after one real tool round-trip. */
export const fakeToolCall = (): AssistantMessage => ({
  role: "assistant",
  content: [
    { type: "text", text: "Let me look around first." },
    {
      type: "toolCall",
      id: "fake-tool-1",
      name: "bash",
      arguments: { command: "sleep 2 && echo fake-tool-ran" },
    },
  ],
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

export const fakeApiKeyAuth = (): ApiKeyAuth => ({
  name: "API key",
  login: async () => ({ type: "api_key" as const, key: "fake" }),
  check: async () => ({ type: "api_key" as const, source: "configured API key" }),
  resolve: async () => ({ auth: { apiKey: "fake" }, source: "configured API key" }),
});

/** The scripted provider: a canned stream, no network. First stream call of
 * a turn carries the tool call, later calls answer with text. */
export const fakeProvider = (): Provider => {
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
  let calls = 0;
  const streams: ProviderStreams = {
    stream: () => {
      const stream = createAssistantMessageEventStream();
      calls += 1;
      stream.end(calls % 2 === 1 ? fakeToolCall() : fakeText());
      return stream;
    },
    streamSimple: () => {
      const stream = createAssistantMessageEventStream();
      calls += 1;
      stream.end(calls % 2 === 1 ? fakeToolCall() : fakeText());
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
