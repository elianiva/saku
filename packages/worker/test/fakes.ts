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

import { Effect, Option } from "effect";
import type {
  Api,
  AssistantMessage,
  AuthCheck,
  AuthResult,
  Model,
  MutableModels,
  Provider,
} from "@earendil-works/pi-ai";
import type { ThreadMode, ThreadState } from "@saku/wire";
import type { ThreadRecord, ThreadRegistryApi } from "../src/registry.ts";

import { FakeError } from "./fake-error.ts";

export const TEST_PROVIDER = "test-provider";
export const TEST_MODEL = "test-model";

/** A minimal pi `Model` (the shape the host's catalog lookups need). */
export const testModel = (): Model<Api> => ({
  api: "test-api",
  baseUrl: "http://localhost",
  contextWindow: 200_000,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
  id: TEST_MODEL,
  input: ["text"],
  maxTokens: 4096,
  name: "Test Model",
  provider: TEST_PROVIDER,
  reasoning: true,
  thinkingLevelMap: {
    high: "high",
    low: "low",
    max: "max",
    medium: "medium",
    minimal: "minimal",
    xhigh: "xhigh",
  },
});

/** A complete `AssistantMessage` for scripted streams and fake completions. */
export const assistantMessage = (
  text: string,
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage => ({
  api: "test-api",
  content: [{ text, type: "text" }],
  model: TEST_MODEL,
  provider: TEST_PROVIDER,
  role: "assistant",
  stopReason,
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

/**
 * A scripted catalog. `completions` feeds `completeSimple` (compaction,
 * auto-title); every provider/model resolves to `testModel`.
 */
export const fakeCatalog = (options: { completions?: string[] } = {}) => {
  const completions = [...(options.completions ?? [])];
  const models: MutableModels = {
    cancelDeferred: async () => {
      // noop
    },
    checkAuth: async (): Promise<AuthCheck | undefined> => {
      return undefined;
    },
    clearProviders: () => {
      // scripted: no providers to clear
    },
    complete: async () => assistantMessage(""),
    completeSimple: async (_model, _context, _options) => {
      const text = completions.shift() ?? "a canned completion";
      return assistantMessage(text);
    },
    deleteProvider: (_id) => {
      // scripted: no providers to delete
    },
    fetchDeferred: () => {
      throw new FakeError({ message: "fake fetchDeferred" });
    },
    getAuth: async (): Promise<AuthResult | undefined> => {
      return undefined;
    },
    getAvailable: async () => [testModel()],
    getModel: () => testModel(),
    getModels: () => [testModel()],
    getProvider: (): Provider | undefined => undefined,
    getProviders: () => [],
    login: () => {
      throw new FakeError({ message: "fake login" });
    },
    logout: async () => {
      // noop
    },
    refresh: async () => ({ aborted: false, errors: new Map() }),
    setProvider: (_provider) => {
      // scripted: no providers to set
    },
    stream: () => {
      throw new FakeError({ message: "fake stream" });
    },
    streamSimple: () => {
      throw new FakeError({ message: "fake streamSimple" });
    },
  };

  return {
    available: () => Effect.succeed([testModel()]),
    getModel: (provider: string, modelId: string) =>
      (provider === TEST_PROVIDER && modelId === TEST_MODEL) ||
      (provider === "opencode-go" && modelId === "deepseek-v4-flash")
        ? testModel()
        : undefined,
    hasAuth: () => Effect.succeed(true),
    models,
    toWireInfo: (model: Model<Api>) => ({
      contextWindow: model.contextWindow,
      id: model.id,
      provider: model.provider,
      reasoning: model.reasoning,
    }),
  };
};

/** An in-memory registry: one thread, states tracked. */
export class FakeRegistry implements ThreadRegistryApi {
  private record: ThreadRecord;
  private state: ThreadState = "idle";

  constructor(record: ThreadRecord) {
    this.record = record;
  }

  list() {
    return Effect.succeed([this.record]);
  }

  get(threadId: string) {
    return Effect.succeed(this.record.id === threadId ? Option.some(this.record) : Option.none());
  }

  create(input: { name: string; cwd?: string; mode?: ThreadMode; autoName?: boolean }) {
    this.record = {
      createdAt: Date.now(),
      cwd: input.cwd ?? "/tmp",
      id: "fake-thread",
      mode: input.mode ?? "local",
      name: input.name,
      nameAuto: input.autoName === true,
      sessionId: null,
    };
    return Effect.succeed(this.record);
  }

  update(threadId: string, patch: Partial<Pick<ThreadRecord, "name" | "sessionId" | "nameAuto">>) {
    if (this.record.id !== threadId) {
      return Effect.succeed(Option.none());
    }
    this.record = { ...this.record, ...patch };
    return Effect.succeed(Option.some(this.record));
  }

  setState(threadId: string, state: ThreadState) {
    if (this.record.id === threadId) {
      this.state = state;
    }
    return Effect.void;
  }

  delete(_threadId: string) {
    void this.record;
    return Effect.succeed(false);
  }

  archive(threadId: string) {
    if (this.record.id !== threadId) {
      return Effect.succeed(Option.none());
    }
    this.record = { ...this.record, archivedAt: Date.now() };
    return Effect.succeed(Option.some(this.record));
  }

  unarchive(threadId: string) {
    if (this.record.id !== threadId) {
      return Effect.succeed(Option.none());
    }
    this.record = { ...this.record, archivedAt: null };
    return Effect.succeed(Option.some(this.record));
  }

  toInfo(threadId: string, tailSeq: number) {
    if (this.record.id !== threadId) {
      return Effect.succeed(Option.none());
    }
    return Effect.succeed(
      Option.some({
        archivedAt: null,
        cwd: this.record.cwd,
        env: "ready" as const,
        id: this.record.id,
        mode: this.record.mode,
        name: this.record.name,
        sessionId: this.record.sessionId,
        state: this.state,
        tailSeq,
      }),
    );
  }

  /** Current wire-visible state (test observation). */
  currentState() {
    return this.state;
  }
}
