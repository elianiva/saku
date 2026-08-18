/**
 * The scripted provider (fake-provider.ts): a canned pi provider behind
 * `SAKU_FAKE_MODEL` — no network, no key. One shared definition for the
 * daemon's catalog (model-catalog.ts) and the deployment's catalog
 * (deploy/src/catalog.ts), so the dev fixture never drifts between hosts.
 *
 * Node-clean (no node: imports): importable from the workerd side of the
 * package, where the module graph must stay isolate-safe.
 */

import { createAssistantMessageEventStream, createProvider } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Model, ProviderStreams } from "@earendil-works/pi-ai";

export const FAKE_PROVIDER = "saku-fake";
export const FAKE_MODEL = "test";

export const fakeText = (): AssistantMessage => ({
  api: "pi-messages",
  content: [{ text: "Hello from the saku-fake model.", type: "text" }],
  model: FAKE_MODEL,
  provider: FAKE_PROVIDER,
  role: "assistant",
  stopReason: "stop",
  timestamp: Date.now(),
  usage: {
    cacheRead: 0,
    cacheWrite: 0,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    input: 10,
    output: 5,
    totalTokens: 15,
  },
});

/** The first answer of a turn asks for a bash tool call; the follow-up is
 * text-only, so a turn ends after one real tool round-trip. */
export const fakeToolCall = (): AssistantMessage => ({
  api: "pi-messages",
  content: [
    { text: "Let me look around first.", type: "text" },
    {
      arguments: { command: "sleep 2 && echo fake-tool-ran" },
      id: "fake-tool-1",
      name: "bash",
      type: "toolCall",
    },
  ],
  model: FAKE_MODEL,
  provider: FAKE_PROVIDER,
  role: "assistant",
  stopReason: "stop",
  timestamp: Date.now(),
  usage: {
    cacheRead: 0,
    cacheWrite: 0,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    input: 10,
    output: 5,
    totalTokens: 15,
  },
});

export const fakeApiKeyAuth = () => ({
  check: async () => ({ source: "configured API key", type: "api_key" as const }),
  login: async () => ({ key: "fake", type: "api_key" as const }),
  name: "API key",
  resolve: async () => ({ auth: { apiKey: "fake" }, source: "configured API key" }),
});

/** The scripted provider: a canned stream, no network. First stream call of
 * a turn carries the tool call, later calls answer with text. */
export const fakeProvider = () => {
  const model: Model<Api> = {
    api: "pi-messages",
    baseUrl: "https://fake.invalid",
    contextWindow: 128_000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id: FAKE_MODEL,
    input: ["text"],
    maxTokens: 16_384,
    name: "test",
    provider: FAKE_PROVIDER,
    reasoning: false,
  };
  let calls = 0;
  // The scripted stream: first call of a turn carries the tool call, later
  // calls answer with text (`stream` and `streamSimple` are the same).
  const fakeStream = () => {
    const stream = createAssistantMessageEventStream();
    calls += 1;
    stream.end(calls % 2 === 1 ? fakeToolCall() : fakeText());
    return stream;
  };
  const streams: ProviderStreams = {
    stream: fakeStream,
    streamSimple: fakeStream,
  };
  return createProvider({
    api: streams,
    auth: { apiKey: fakeApiKeyAuth() },
    baseUrl: "https://fake.invalid",
    id: FAKE_PROVIDER,
    models: [model],
    name: "saku-fake",
  });
};
