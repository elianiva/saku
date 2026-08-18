/**
 * SessionHost tests: the effect-machine host over a DO-backed trail, driven
 * with scripted model streams and a stub env — no network, no real LLM.
 */

import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { NodeFileSystem } from "@effect/platform-node";
import type { Layer } from "effect";
import { Effect, FileSystem, Option, Schema } from "effect";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessage,
  Context as PiContext,
  Model,
  SimpleStreamOptions,
  TextContent,
} from "@earendil-works/pi-ai";
import type { Entry, SessionRepo, StreamFn } from "@earendil-works/pi-agent-core";
import type { ThreadRecord } from "../src/registry.ts";
import { SessionHost } from "../src/session-host.ts";
import type { HostEventSink, HostState, SessionHostOptions } from "../src/session-host.ts";
import { DoSessionRepo } from "../src/do-session-repo.ts";
import type { DoSessionMetadata } from "../src/do-session.ts";
import { KvStore } from "@saku/store";
import { Paths, PathsTest } from "../src/paths.ts";
import { assistantMessage, fakeCatalog, FakeRegistry, TEST_MODEL, TEST_PROVIDER } from "./fakes.ts";
import { StubEnv } from "./stub-env.ts";
import { expectPresent } from "./expect.ts";

const THREAD_ID = "0123456789abcdef0123456789abcdef";

const record = (): ThreadRecord => ({
  createdAt: Date.now(),
  cwd: "/work",
  id: THREAD_ID,
  mode: "local",
  name: "quick thread",
  nameAuto: true,
  sessionId: null,
});

/** A polling assertion that gave up (the host machine hadn't moved in time). */
class TestError extends Schema.TaggedError<TestError>()("TestError", {
  message: Schema.String,
}) {}

/** Wait for the host's lifecycle tag (the machine moves asynchronously). */
const waitForState = async (host: SessionHost, state: HostState, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<void> => {
    if (host.threadState === state) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new TestError({
        message: `host state ${state} not reached; last: ${host.threadState}`,
      });
    }
    await sleep(5);
    await poll();
  };
  await poll();
};

/** A scripted stream that emits one assistant message immediately. */
const oneShotStream = (text: string, stopReason: AssistantMessage["stopReason"] = "stop") => {
  const message = assistantMessage(text, stopReason);
  return () => {
    const stream = createAssistantMessageEventStream();
    stream.end(message);
    return stream;
  };
};

/** A stream that ends only when the run's abort signal fires. */
const abortableStream = () => {
  const message = assistantMessage("aborted run", "aborted");
  const started = Promise.withResolvers<true>();
  const streamFn = (_model: Model<Api>, _context: PiContext, options?: SimpleStreamOptions) => {
    const stream = createAssistantMessageEventStream();
    options?.signal?.addEventListener(
      "abort",
      () => {
        stream.push({ error: message, reason: "aborted", type: "error" });
        stream.end(message);
      },
      { once: true },
    );
    started.resolve(true);
    return stream;
  };
  return { started: started.promise, streamFn };
};

/** A stream that waits for an external gate before ending. */
const gated = () => {
  const message = assistantMessage("slow");
  const stream = createAssistantMessageEventStream();
  return {
    release: () => {
      stream.end(message);
    },
    streamFn: () => stream,
  };
};

/** Build a KvStore value from a backend layer (the pi seam is value-shaped). */
const buildKv = async (layer: Layer.Layer<KvStore>) =>
  await Effect.runPromise(
    Effect.gen(function* () {
      const kv = yield* KvStore;
      return kv;
    }).pipe(Effect.provide(layer)),
  );

interface HostWorld {
  readonly host: SessionHost;
  readonly registry: FakeRegistry;
  readonly events: { type: string }[];
  readonly fs: FileSystem.FileSystem;
  readonly kvRoot: string;
}

interface HostOptions {
  readonly streamFn?: StreamFn;
  readonly env?: StubEnv;
  readonly nameAuto?: boolean;
  readonly completions?: string[];
}

/** Host options with the test seam writable (SessionHostOptions is readonly). */
type MutableHostOptions = Omit<SessionHostOptions, "streamFn"> & { streamFn?: StreamFn };

/** Build a host over a fresh trail (the FileSystem service is provided by the caller). */
const makeHost = Effect.fn("makeHost")(function* (options: HostOptions = {}) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Paths;
  const registry = new FakeRegistry(record());
  if (options.nameAuto === false) {
    yield* registry.update(THREAD_ID, { nameAuto: false });
  }
  const events: { type: string }[] = [];
  const sink: HostEventSink = (event) => {
    events.push({ type: event.type });
  };
  const catalogOptions =
    options.completions === undefined ? {} : { completions: options.completions };
  const hostOptions: MutableHostOptions = {
    catalog: fakeCatalog(catalogOptions),
    env: options.env ?? new StubEnv("/work"),
    record: yield* registry.get(THREAD_ID).pipe(Effect.map(Option.getOrThrow)),
    registry,
    sink,
    threadId: THREAD_ID,
  };
  if (options.streamFn !== undefined) {
    hostOptions.streamFn = options.streamFn;
  }
  const host = yield* SessionHost.create(hostOptions).pipe(
    // The test trail is file-backed under the thread's directory.
    Effect.provide(KvStore.file(fs, paths.threadTrailRoot(THREAD_ID))),
  );
  return { events, fs, host, kvRoot: paths.threadTrailRoot(THREAD_ID), registry };
});

/** The host's trail layout: a fresh scoped temp home (no env mutation). */
const testPaths = (home?: string) => PathsTest(home);

/** Run one test against a fresh host; the host is disposed on the way out. */
const scoped = async <A>(
  run: (world: HostWorld) => Promise<A>,
  options: HostOptions = {},
  home?: string,
) =>
  await Effect.runPromise(
    Effect.gen(function* () {
      const world = yield* makeHost(options);
      const outcome = yield* Effect.tryPromise(async () => await run(world)).pipe(
        Effect.ensuring(world.host.dispose()),
      );
      return outcome;
      // The test-path layer's build needs the FileSystem service, so the
      // Node layer goes outermost (layer builds see the context at their
      // provide site — deps outer, dependents inner).
    }).pipe(Effect.provide(testPaths(home)), Effect.provide(NodeFileSystem.layer)),
  );

describe("SessionHost", () => {
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
      expect(leafId).toBe(expectPresent(entries[1], "the second initial entry").id);
    });
  });

  it("prompt runs end to end: entries appended, settled emitted, back to idle", async () => {
    await scoped(
      async ({ host, events }) => {
        await Effect.runPromise(host.prompt("hello"));
        await waitForState(host, "idle");
        const { entries, tailSeq } = await Effect.runPromise(host.getEntries());
        const messages = entries.filter((entry) => entry.type === "message");
        expect(messages).toHaveLength(2);
        const user = expectPresent(messages[0], "the user message").message;
        if (user.role !== "user") {
          throw new Error("expected the first message to be a user message");
        }
        expect(user.role).toBe("user");
        const userText = Array.isArray(user.content)
          ? user.content.find((content): content is TextContent => content.type === "text")
          : undefined;
        expect(userText?.text).toBe("hello");
        const assistant = expectPresent(messages[1], "the assistant message").message;
        if (assistant.role !== "assistant") {
          throw new Error("expected the second message to be an assistant message");
        }
        expect(assistant.role).toBe("assistant");
        expect(assistant.stopReason).toBe("stop");
        // model_change + thinking_level_change + user + assistant
        expect(tailSeq).toBe(4);
        expect(events.some((event) => event.type === "settled")).toBe(true);
        expect(events.filter((event) => event.type === "entry_appended").length).toBe(2);
        const state = await Effect.runPromise(host.getState());
        expect(state.state).toBe("idle");
        expect(state.tailSeq).toBe(4);
      },
      { streamFn: oneShotStream("hi there") },
    );
  });

  it("rejects a second prompt while working", async () => {
    const gate = gated();
    await scoped(
      async ({ host }) => {
        const running = Effect.runPromise(host.prompt("first"));
        await waitForState(host, "working");
        await expect(Effect.runPromise(host.prompt("second"))).rejects.toThrow(
          "already processing",
        );
        gate.release();
        await running;
        await waitForState(host, "idle");
      },
      { streamFn: gate.streamFn },
    );
  });

  it("abort settles the run as aborted", async () => {
    const stream = abortableStream();
    await scoped(
      async ({ host }) => {
        const running = Effect.runPromise(host.prompt("go"));
        await waitForState(host, "working");
        await stream.started;
        await Effect.runPromise(host.abort());
        await running;
        await waitForState(host, "idle");
        const state = await Effect.runPromise(host.getState());
        expect(state.state).toBe("idle");
        const { entries } = await Effect.runPromise(host.getEntries());
        const assistant = entries.find(
          (entry): entry is Extract<Entry, { readonly type: "message" }> =>
            entry.type === "message" && entry.message.role === "assistant",
        );
        const { message } = expectPresent(assistant, "the assistant message");
        if (message.role !== "assistant") {
          throw new Error("expected an assistant message");
        }
        expect(message.stopReason).toBe("aborted");
      },
      { streamFn: stream.streamFn },
    );
  });

  it("setModel persists a model_change entry; unknown models fail", async () => {
    await scoped(async ({ host }) => {
      const model = await Effect.runPromise(host.setModel(TEST_PROVIDER, TEST_MODEL));
      expect(model?.id).toBe(TEST_MODEL);
      const { entries } = await Effect.runPromise(host.getEntries());
      expect(
        entries.some((entry) => entry.type === "model_change" && entry.modelId === TEST_MODEL),
      ).toBe(true);
      await expect(Effect.runPromise(host.setModel("nope", "nope"))).rejects.toThrow(
        "unknown model",
      );
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
        entries.some(
          (entry) => entry.type === "thinking_level_change" && entry.thinkingLevel === "high",
        ),
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
    await scoped(
      async ({ host, registry }) => {
        await Effect.runPromise(host.prompt("build the thing"));
        // Auto-title is best-effort after settled; poll for the rename.
        const deadline = Date.now() + 3000;
        const pollName = async (): Promise<string> => {
          const current = await Effect.runPromise(
            registry.get(THREAD_ID).pipe(Effect.map((r) => (Option.isSome(r) ? r.value.name : ""))),
          );
          if (current !== "quick thread" || Date.now() >= deadline) {
            return current;
          }
          await sleep(10);
          return await pollName();
        };
        const name = await pollName();
        expect(name).toBe("A Perfect Title — quick thread");
      },
      { completions: ["A Perfect Title"], streamFn: oneShotStream("hi") },
    );
  });

  it("branch moves the lane leaf", async () => {
    await scoped(
      async ({ host }) => {
        await Effect.runPromise(host.prompt("first"));
        const { entries, leafId } = await Effect.runPromise(host.getEntries());
        const firstId = expectPresent(entries[0], "the first entry").id;
        expect(leafId).not.toBe(firstId);
        await waitForState(host, "idle");
        const moved = await Effect.runPromise(host.branch(firstId));
        expect(moved).toBe(firstId);
        const after = await Effect.runPromise(host.getEntries());
        expect(after.leafId).toBe(firstId);
      },
      { streamFn: oneShotStream("hi") },
    );
  });

  it("branch fails while working", async () => {
    const gate = gated();
    await scoped(
      async ({ host }) => {
        const running = Effect.runPromise(host.prompt("first"));
        await waitForState(host, "working");
        await expect(Effect.runPromise(host.branch("x"))).rejects.toThrow(
          "cannot branch while the agent is working",
        );
        gate.release();
        await running;
        await waitForState(host, "idle");
      },
      { streamFn: gate.streamFn },
    );
  });

  it("manual compaction runs and persists a compaction entry", async () => {
    await scoped(
      async ({ host, events }) => {
        // A trail with messages, so there is something to compact.
        await Effect.runPromise(host.prompt("first"));
        await waitForState(host, "idle");
        const result = await Effect.runPromise(host.compact("summarize it"));
        await waitForState(host, "idle");
        expect(result.summary).toBe("a canned completion");
        expect(events.some((event) => event.type === "compaction_start")).toBe(true);
        expect(events.some((event) => event.type === "compaction_end")).toBe(true);
        const { entries } = await Effect.runPromise(host.getEntries());
        expect(entries.some((entry) => entry.type === "compaction")).toBe(true);
      },
      { completions: ["a canned completion"], streamFn: oneShotStream("hi") },
    );
  });

  it("rejects compaction while working", async () => {
    const gate = gated();
    await scoped(
      async ({ host }) => {
        const running = Effect.runPromise(host.prompt("first"));
        await waitForState(host, "working");
        await expect(Effect.runPromise(host.compact())).rejects.toThrow(
          "cannot compact while the agent is working",
        );
        gate.release();
        await running;
      },
      { streamFn: gate.streamFn },
    );
  });

  it("recovers as interrupted when the trail has an open operation", async () => {
    // One shared layout across both boots: a crash simulation must boot the
    // second host over the SAME trail (a fresh `PathsTest()` per boot would
    // give it a different temp home, i.e. an empty registry of trails).
    const home = await Effect.runPromise(
      Effect.provide(NodeFileSystem.layer)(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return yield* fs.makeTempDirectory({ directory: tmpdir(), prefix: "saku-host-recover-" });
        }),
      ),
    );
    try {
      await scoped(
        async ({ host, fs, kvRoot }) => {
          await Effect.runPromise(host.prompt("first"));
          await waitForState(host, "idle");
          const repo: SessionRepo<DoSessionMetadata> = new DoSessionRepo(
            await buildKv(KvStore.file(fs, kvRoot)),
          );
          const listed = await repo.list();
          const metadata = expectPresent(listed[0], "the session");
          const session = await repo.open(metadata);
          await session.appendRecord({
            id: "op-crashed",
            intent: { initialMessages: [], kind: "run", originalPrompt: [] },
            lane: "main",
            sourceLeafId: null,
            type: "operation_started",
          });

          // A new host over the same trail boots into Interrupted.
          const second = await Effect.runPromise(
            Effect.gen(function* () {
              const paths = yield* Paths;
              const registry = new FakeRegistry(record());
              return yield* SessionHost.create({
                catalog: fakeCatalog(),
                env: new StubEnv("/work"),
                record: yield* registry.get(THREAD_ID).pipe(Effect.map(Option.getOrThrow)),
                registry,
                sink: () => {},
                threadId: THREAD_ID,
              }).pipe(Effect.provide(KvStore.file(fs, paths.threadTrailRoot(THREAD_ID))));
            }).pipe(Effect.provide(testPaths(home)), Effect.provide(NodeFileSystem.layer)),
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
        },
        { streamFn: oneShotStream("hi") },
        home,
      );
    } finally {
      await Effect.runPromise(
        Effect.provide(NodeFileSystem.layer)(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            yield* fs.remove(home, { force: true, recursive: true });
          }),
        ).pipe(Effect.catch(() => Effect.void)),
      );
    }
  });

  it("dispose settles and drains", async () => {
    await scoped(
      async ({ host }) => {
        await Effect.runPromise(host.prompt("bye"));
        await Effect.runPromise(host.dispose());
      },
      { streamFn: oneShotStream("bye") },
    );
  });
});
