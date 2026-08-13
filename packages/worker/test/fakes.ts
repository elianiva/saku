/**
 * Host test fixtures (fakes.ts): a scripted model catalog and an in-memory
 * thread registry, so the session host can be driven hermetically — no
 * filesystem beyond the trail, no network, no real LLM.
 *
 * The `MutableModels` surface is large; the fake implements only what the
 * host exercises (getAvailable, completeSimple) and fails loudly on anything
 * else, so a test that accidentally reaches an unimplemented path breaks
 * instead of silently passing.
 */

import { Effect, Option, Schema } from "effect";
import type {
  Api,
  AssistantMessage,
  Model,
  MutableModels,
  Provider,
  SimpleStreamOptions,
  Context as PiContext,
} from "@earendil-works/pi-ai";
import type { ThreadInfo, ThreadMode, ThreadState } from "@saku/wire";
import type { ModelCatalogShape } from "../src/model-catalog.ts";
import type { ThreadRecord, ThreadRegistryShape } from "../src/registry.ts";

export const TEST_PROVIDER = "test-provider";
export const TEST_MODEL = "test-model";

/** A minimal pi `Model` (the shape the host's catalog lookups need). */
export const testModel = (): Model<Api> => ({
  id: TEST_MODEL,
  name: "Test Model",
  api: "test-api",
  provider: TEST_PROVIDER,
  baseUrl: "http://localhost",
  reasoning: true,
  thinkingLevelMap: {
    minimal: "minimal",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  },
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 4096,
});

/** A complete `AssistantMessage` for scripted streams and fake completions. */
export const assistantMessage = (
  text: string,
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "test-api",
  provider: TEST_PROVIDER,
  model: TEST_MODEL,
  usage: {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason,
  timestamp: Date.now(),
});

/** A scripted failure of the fake catalog (an unimplemented or failing surface). */
class FakeError extends Schema.TaggedError<FakeError>()("FakeError", {
  message: Schema.String,
}) {}

const unimplemented = (name: string): never => {
  throw new FakeError(
    `fake models: ${name} is not implemented — the host should not call it in these tests`,
  );
};

/**
 * A scripted catalog. `completions` feeds `completeSimple` (compaction,
 * auto-title); every provider/model resolves to `testModel`.
 */
export const fakeCatalog = (options: { completions?: string[] } = {}): ModelCatalogShape => {
  const completions = [...(options.completions ?? [])];
  const models: MutableModels = {
    getProviders: () => [],
    getProvider: () => undefined,
    getModels: () => [testModel()],
    getModel: () => testModel(),
    refresh: async () => ({ ok: true, failed: [], refreshed: [], cancelled: [] }),
    checkAuth: async () => undefined,
    getAvailable: async () => [testModel()],
    getAuth: async () => undefined,
    login: async () => {
      throw new FakeError("fake login");
    },
    logout: async () => {},
    stream: () => {
      throw new FakeError("fake stream");
    },
    complete: async () => assistantMessage(""),
    streamSimple: () => {
      throw new FakeError("fake streamSimple");
    },
    completeSimple: async (
      _model: Model<Api>,
      _context: PiContext,
      _options?: SimpleStreamOptions,
    ): Promise<AssistantMessage> => {
      const text = completions.shift() ?? "a canned completion";
      return assistantMessage(text);
    },
    fetchDeferred: async () => assistantMessage(""),
    cancelDeferred: async () => {},
    setProvider: (_provider: Provider) => {},
    deleteProvider: (_id: string) => {},
    clearProviders: () => {},
  } as unknown as MutableModels;

  return {
    models,
    available: () => Effect.succeed([testModel()]),
    hasAuth: () => Effect.succeed(true),
    // The auto-title provider pair is a known model too; anything else is unknown.
    getModel: (provider, modelId) =>
      (provider === TEST_PROVIDER && modelId === TEST_MODEL) ||
      (provider === "opencode-go" && modelId === "deepseek-v4-flash")
        ? testModel()
        : undefined,
    toWireInfo: (model) => ({
      provider: model.provider,
      id: model.id,
      contextWindow: model.contextWindow,
      reasoning: model.reasoning,
    }),
  };
};

/** An in-memory registry: one thread, states tracked. */
export class FakeRegistry implements ThreadRegistryShape {
  private record: ThreadRecord;
  private state: ThreadState = "idle";

  constructor(record: ThreadRecord) {
    this.record = record;
  }

  list(): Effect.Effect<readonly ThreadRecord[], never> {
    return Effect.succeed([this.record]);
  }

  get(threadId: string): Effect.Effect<Option.Option<ThreadRecord>, never> {
    return Effect.succeed(this.record.id === threadId ? Option.some(this.record) : Option.none());
  }

  create(input: {
    name: string;
    cwd?: string;
    mode?: ThreadMode;
    autoName?: boolean;
  }): Effect.Effect<ThreadRecord, never> {
    this.record = {
      id: "fake-thread",
      name: input.name,
      cwd: input.cwd ?? "/tmp",
      mode: input.mode ?? "local",
      createdAt: Date.now(),
      sessionId: null,
      nameAuto: input.autoName === true,
    };
    return Effect.succeed(this.record);
  }

  update(
    threadId: string,
    patch: Partial<Pick<ThreadRecord, "name" | "sessionId" | "nameAuto">>,
  ): Effect.Effect<Option.Option<ThreadRecord>, never> {
    if (this.record.id !== threadId) return Effect.succeed(Option.none());
    this.record = { ...this.record, ...patch };
    return Effect.succeed(Option.some(this.record));
  }

  setState(threadId: string, state: ThreadState): Effect.Effect<void, never> {
    if (this.record.id === threadId) this.state = state;
    return Effect.void;
  }

  delete(threadId: string): Effect.Effect<boolean, never> {
    return Effect.succeed(false);
  }

  toInfo(threadId: string, tailSeq: number): Effect.Effect<Option.Option<ThreadInfo>, never> {
    if (this.record.id !== threadId) return Effect.succeed(Option.none());
    return Effect.succeed(
      Option.some({
        id: this.record.id,
        name: this.record.name,
        cwd: this.record.cwd,
        mode: this.record.mode,
        state: this.state,
        env: "ready",
        sessionId: this.record.sessionId,
        tailSeq,
      }),
    );
  }

  /** Current wire-visible state (test observation). */
  currentState(): ThreadState {
    return this.state;
  }
}
