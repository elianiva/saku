/**
 * SessionHost tests: the effect-machine host over a DO-backed trail, driven
 * with scripted model streams and a stub env — no network, no real LLM.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, FileSystem, Option } from "effect";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ThreadRecord } from "../src/registry.ts";
import { SessionHost, type HostEventSink, type HostState } from "../src/session-host.ts";
import { DoSessionRepo } from "../src/do-session.ts";
import { fileKv } from "../src/kv.ts";
import { getThreadTrailRoot } from "../src/paths.ts";
import { assistantMessage, fakeCatalog, FakeRegistry, TEST_MODEL, TEST_PROVIDER } from "./fakes.ts";
import { StubEnv } from "./stub-env.ts";

const THREAD_ID = "0123456789abcdef0123456789abcdef";

const record = (): ThreadRecord => ({
  id: THREAD_ID,
  name: "quick thread",
  cwd: "/work",
  mode: "local",
  createdAt: Date.now(),
  sessionId: null,
  nameAuto: true,
});

/** Wait for the host's lifecycle tag (the machine moves asynchronously). */
const waitForState = async (host: SessionHost, state: HostState, timeoutMs = 3000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (host.threadState === state) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`host state ${state} not reached; last: ${host.threadState}`);
};

/** A scripted stream that emits one assistant message immediately. */
const oneShotStream = (text: string, stopReason: AssistantMessage["stopReason"] = "stop"): StreamFn => {
  const message = assistantMessage(text, stopReason);
  return () => {
    const stream = new AssistantMessageEventStream();
    stream.end(message);
    return stream;
  };
};

/** A stream that ends only when the run's abort signal fires. */
const abortableStream = (): StreamFn => {
  const message = assistantMessage("aborted run", "aborted");
  return (_model, _context, options) => {
    const stream = new AssistantMessageEventStream();
    options?.signal?.addEventListener(
      "abort",
      () => {
        stream.push({ type: "error", reason: "aborted", error: message });
        stream.end(message);
      },
      { once: true },
    );
    return stream;
  };
};

/** A stream that waits for an external gate before ending. */
const gated = (): { streamFn: StreamFn; release: () => void } => {
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const message = assistantMessage("slow");
  const stream = new AssistantMessageEventStream();
  void gate.then(() => {
    stream.end(message);
  });
  return { streamFn: () => stream, release };
};

interface HostWorld {
  readonly host: SessionHost;
  readonly registry: FakeRegistry;
  readonly events: Array<{ type: string }>;
  readonly fs: FileSystem.FileSystem;
  readonly kvRoot: string;
}

interface HostOptions {
  readonly streamFn?: StreamFn;
  readonly env?: StubEnv;
  readonly nameAuto?: boolean;
  readonly completions?: string[];
}

/** Build a host over a fresh trail (the FileSystem service is provided by the caller). */
const makeHost = (options: HostOptions = {}): Effect.Effect<HostWorld, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const registry = new FakeRegistry(record());
    if (options.nameAuto === false) {
      yield* registry.update(THREAD_ID, { nameAuto: false });
    }
    const events: Array<{ type: string }> = [];
    const sink: HostEventSink = (event) => {
      events.push({ type: event.type });
    };
    const host = yield* SessionHost.create({
      threadId: THREAD_ID,
      record: yield* registry.get(THREAD_ID).pipe(Effect.map(Option.getOrThrow)),
      fs,
      catalog: fakeCatalog({ completions: options.completions }),
      registry,
      sink,
      ...(options.streamFn === undefined ? {} : { streamFn: options.streamFn }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    return { host, registry, events, fs, kvRoot: getThreadTrailRoot(THREAD_ID) };
  });

/** Run one test against a fresh host; the host is disposed on the way out. */
const scoped = <A>(run: (world: HostWorld) => Promise<A>, options: HostOptions = {}): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const world = yield* makeHost(options);
      return yield* Effect.tryPromise(() => run(world)).pipe(Effect.ensuring(world.host.dispose()));
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

describe("SessionHost", () => {
  let home: string;

  beforeEach(async () => {
    home = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.makeTempDirectory({ prefix: "saku-host-" });
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    );
    process.env.SAKU_HOME = home;
  });

  afterEach(async () => {
    delete process.env.SAKU_HOME;
    await Effect.runPromise(
      Effect.provide(NodeFileSystem.layer)(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.remove(home, { recursive: true, force: true }).pipe(Effect.catch(() => Effect.void));
        }),
      ),
    );
  });

  it("starts with a fresh trail: idle, model persisted, no entries", async () => {
    await scoped(async ({ host }) => {
      const state = await Effect.runPromise(host.getState());
      expect(state.sessionId).toBe(THREAD_ID);
      expect(state.state).toBe("idle");
      expect(state.model?.provider).toBe(TEST_PROVIDER);
      expect(state.model?.id).toBe(TEST_MODEL);
      expect(state.thinkingLevel).toBe("off");
      // A fresh trail starts with the two initial entries (model + thinking).
      expect(state.tailSeq).toBe(2);
      const { entries, tailSeq, leafId } = await Effect.runPromise(host.getEntries());
      expect(entries.map((entry) => entry.type)).toEqual(["model_change", "thinking_level_change"]);
      expect(tailSeq).toBe(2);
      // The lane leaf points at the last appended entry.
      expect(leafId).toBe(entries[1]!.id);
    });
  });

  it("prompt runs end to end: entries appended, settled emitted, back to idle", async () => {
    await scoped(async ({ host, events }) => {
      await Effect.runPromise(host.prompt("hello"));
      await waitForState(host, "idle");
      const { entries, tailSeq } = await Effect.runPromise(host.getEntries());
      const messages = entries.filter((entry) => entry.type === "message");
      expect(messages).toHaveLength(2);
      const user = messages[0]!.message as AssistantMessage;
      const assistant = messages[1]!.message as AssistantMessage;
      expect(user.role).toBe("user");
      const userText = user.content.find((content): content is TextContent => content.type === "text");
      expect(userText?.text).toBe("hello");
      expect(assistant.role).toBe("assistant");
      expect(assistant.stopReason).toBe("stop");
      expect(tailSeq).toBe(4); // model_change + thinking_level_change + user + assistant
      expect(events.some((event) => event.type === "settled")).toBe(true);
      expect(events.filter((event) => event.type === "entry_appended").length).toBe(2);
      const state = await Effect.runPromise(host.getState());
      expect(state.state).toBe("idle");
      expect(state.tailSeq).toBe(4);
    }, { streamFn: oneShotStream("hi there") });
  });

  it("rejects a second prompt while working", async () => {
    const gate = gated();
    await scoped(async ({ host }) => {
      const running = Effect.runPromise(host.prompt("first"));
      await waitForState(host, "working");
      await expect(Effect.runPromise(host.prompt("second"))).rejects.toThrow("already processing");
      gate.release();
      await running;
      await waitForState(host, "idle");
    }, { streamFn: gate.streamFn });
  });

  it("abort settles the run as aborted", async () => {
    await scoped(async ({ host }) => {
      const running = Effect.runPromise(host.prompt("go"));
      await waitForState(host, "working");
      await Effect.runPromise(host.abort());
      await running;
      await waitForState(host, "idle");
      const state = await Effect.runPromise(host.getState());
      expect(state.state).toBe("idle");
      const { entries } = await Effect.runPromise(host.getEntries());
      const assistant = entries.find(
        (entry) => entry.type === "message" && entry.message.role === "assistant",
      );
      expect(assistant?.message.stopReason).toBe("aborted");
    }, { streamFn: abortableStream() });
  });

  it("setModel persists a model_change entry; unknown models fail", async () => {
    await scoped(async ({ host }) => {
      const model = await Effect.runPromise(host.setModel(TEST_PROVIDER, TEST_MODEL));
      expect(model?.id).toBe(TEST_MODEL);
      const { entries } = await Effect.runPromise(host.getEntries());
      expect(entries.some((entry) => entry.type === "model_change" && entry.modelId === TEST_MODEL)).toBe(true);
      await expect(Effect.runPromise(host.setModel("nope", "nope"))).rejects.toThrow("unknown model");
    });
  });

  it("setThinkingLevel clamps and persists", async () => {
    await scoped(async ({ host }) => {
      const level = await Effect.runPromise(host.setThinkingLevel("high"));
      expect(level).toBe("high");
      const state = await Effect.runPromise(host.getState());
      expect(state.thinkingLevel).toBe("high");
      const { entries } = await Effect.runPromise(host.getEntries());
      expect(
        entries.some((entry) => entry.type === "thinking_level_change" && entry.thinkingLevel === "high"),
      ).toBe(true);
    });
  });

  it("setSessionName persists into the trail", async () => {
    await scoped(async ({ host }) => {
      await Effect.runPromise(host.setSessionName("my session"));
      const state = await Effect.runPromise(host.getState());
      expect(state.name).toBe("my session");
    });
  });

  it("auto-titles a quick-started thread after its first run", async () => {
    await scoped(async ({ host, registry }) => {
      await Effect.runPromise(host.prompt("build the thing"));
      // Auto-title is best-effort after settled; poll for the rename.
      const deadline = Date.now() + 3000;
      let name = await Effect.runPromise(
        registry.get(THREAD_ID).pipe(Effect.map((r) => (Option.isSome(r) ? r.value.name : ""))),
      );
      while (name === "quick thread" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        name = await Effect.runPromise(
          registry.get(THREAD_ID).pipe(Effect.map((r) => (Option.isSome(r) ? r.value.name : ""))),
        );
      }
      expect(name).toBe("A Perfect Title — quick thread");
    }, { streamFn: oneShotStream("hi"), completions: ["A Perfect Title"] });
  });

  it("branch moves the lane leaf", async () => {
    await scoped(async ({ host }) => {
      await Effect.runPromise(host.prompt("first"));
      const { entries, leafId } = await Effect.runPromise(host.getEntries());
      const firstId = entries[0]!.id;
      expect(leafId).not.toBe(firstId);
      await waitForState(host, "idle");
      const moved = await Effect.runPromise(host.branch(firstId));
      expect(moved).toBe(firstId);
      const after = await Effect.runPromise(host.getEntries());
      expect(after.leafId).toBe(firstId);
    }, { streamFn: oneShotStream("hi") });
  });

  it("branch fails while working", async () => {
    const gate = gated();
    await scoped(async ({ host }) => {
      const running = Effect.runPromise(host.prompt("first"));
      await waitForState(host, "working");
      await expect(Effect.runPromise(host.branch("x"))).rejects.toThrow("cannot branch while the agent is working");
      gate.release();
      await running;
      await waitForState(host, "idle");
    }, { streamFn: gate.streamFn });
  });

  it("manual compaction runs and persists a compaction entry", async () => {
    await scoped(async ({ host, events }) => {
      // A trail with messages, so there is something to compact.
      await Effect.runPromise(host.prompt("first"));
      await waitForState(host, "idle");
      const result = await Effect.runPromise(host.compact("summarize it"));
      await waitForState(host, "idle");
      expect((result as { summary: string }).summary).toBe("a canned completion");
      expect(events.some((event) => event.type === "compaction_start")).toBe(true);
      expect(events.some((event) => event.type === "compaction_end")).toBe(true);
      const { entries } = await Effect.runPromise(host.getEntries());
      expect(entries.some((entry) => entry.type === "compaction")).toBe(true);
    }, { streamFn: oneShotStream("hi"), completions: ["a canned completion"] });
  });

  it("rejects compaction while working", async () => {
    const gate = gated();
    await scoped(async ({ host }) => {
      const running = Effect.runPromise(host.prompt("first"));
      await waitForState(host, "working");
      await expect(Effect.runPromise(host.compact())).rejects.toThrow("cannot compact while the agent is working");
      gate.release();
      await running;
    }, { streamFn: gate.streamFn });
  });

  it("recovers as interrupted when the trail has an open operation", async () => {
    // Run once, then simulate a crash: an operation_started record without
    // its operation_finished, written straight into the trail.
    await scoped(async ({ host, fs, kvRoot }) => {
      await Effect.runPromise(host.prompt("first"));
      await waitForState(host, "idle");
      const repo = new DoSessionRepo(fileKv(fs, kvRoot));
      const [metadata] = await repo.list();
      const session = await repo.open(metadata);
      await session.appendRecord({
        type: "operation_started",
        id: "op-crashed",
        lane: "main",
        sourceLeafId: null,
        intent: { kind: "run", originalPrompt: [], initialMessages: [] },
      });

      // A new host over the same trail boots into Interrupted.
      const second = await Effect.runPromise(
        Effect.gen(function* () {
          const registry = new FakeRegistry(record());
          return yield* SessionHost.create({
            threadId: THREAD_ID,
            record: yield* registry.get(THREAD_ID).pipe(Effect.map(Option.getOrThrow)),
            fs,
            catalog: fakeCatalog(),
            registry,
            sink: () => {},
          });
        }).pipe(Effect.provide(NodeFileSystem.layer)),
      );
      try {
        await waitForState(second, "interrupted");
        const state = await Effect.runPromise(second.getState());
        expect(state.state).toBe("interrupted");
        // A run after interruption proceeds normally.
        await Effect.runPromise(second.prompt("again"));
        await waitForState(second, "idle");
      } finally {
        await Effect.runPromise(second.dispose());
      }
    }, { streamFn: oneShotStream("hi") });
  });

  it("dispose settles and drains", async () => {
    await scoped(async ({ host }) => {
      await Effect.runPromise(host.prompt("bye"));
      await Effect.runPromise(host.dispose());
    }, { streamFn: oneShotStream("bye") });
  });
});
