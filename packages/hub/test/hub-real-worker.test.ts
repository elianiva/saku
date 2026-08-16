/**
 * Real-worker integration tests: the full stack, no mocks — wire client ⇄
 * hub server ⇄ hub core ⇄ in-process `ThreadWorkerRef` ⇄ real
 * `SessionHost` (Agent + Session over a DO-style trail, scripted stream,
 * stub env). Proves the managed-agents seam end to end: lazy sessions
 * (reads before a prompt answer without starting one), a prompt that runs
 * and settles with streamed events and working → idle broadcasts, sessionId
 * back-fill and auto-title reporting to the hub, and thread deletion
 * removing the trail.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Exit, FileSystem, Schema, Scope } from "effect";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Paths, PathsTest } from "@saku/worker";
import type { PathsLayout } from "@saku/worker";
import { KvStore } from "@saku/store";
import { WireClient } from "@saku/wire";
import type { ThreadInfo } from "@saku/wire";

import { Hub, HubRegistry, HubServer, SkillsStore } from "../src/index.ts";
import { inProcessWorker } from "./in-process-worker.ts";
import { scriptedProvisioner } from "./mock-worker.ts";
import {
  assistantMessage,
  fakeCatalog,
  TEST_MODEL,
  TEST_PROVIDER,
} from "../../worker/test/fakes.ts";

const TEST_TOKEN = "hub-test-secret";

/** A scripted stream that emits one assistant message immediately. */
const oneShotStream = (text: string) => {
  const message = assistantMessage(text);
  return () => {
    const stream = createAssistantMessageEventStream();
    stream.end(message);
    return stream;
  };
};

interface World {
  readonly url: string;
  readonly fs: FileSystem.FileSystem;
  readonly paths: PathsLayout;
  readonly scope: Scope.Scope;
}

let world: World;

/** The catalog + scripted stream + stub env the suites run on. */
const workerCatalog = (completions: string[] = []) => fakeCatalog({ completions });

beforeEach(async () => {
  // The scope outlives the building run: it holds the server open and the
  // test layout (`PathsTest`) alive until afterEach closes it.
  const scope = await Effect.runPromise(Scope.make());
  const { fs, paths, url } = await Effect.runPromise(
    Effect.gen(function* built() {
      const fileSystem = yield* FileSystem.FileSystem;
      const layout = yield* Paths;
      const registry = yield* HubRegistry.make().pipe(Effect.provide(KvStore.memory()));
      const skills = yield* SkillsStore.make().pipe(Effect.provide(KvStore.memory()));
      const worker = yield* inProcessWorker({
        catalog: workerCatalog(),
        fs: fileSystem,
        paths: layout,
        streamFn: oneShotStream("a canned response"),
      });
      const hub = yield* Hub.make({
        provisioner: scriptedProvisioner(),
        registry,
        skills,
        workerRef: worker.ref,
      });
      worker.attach(hub.events);
      const server = yield* HubServer.make({ hub, token: TEST_TOKEN }).pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      return { fs: fileSystem, paths: layout, url: server.url };
    }).pipe(
      Effect.provide(PathsTest()),
      Effect.provideService(Scope.Scope, scope),
      Effect.provide(NodeFileSystem.layer),
    ),
  );
  world = { fs, paths, scope, url };
});

afterEach(async () => {
  // Closing the scope releases the server and removes the test layout.
  await Effect.runPromise(Scope.close(world.scope, Exit.void));
});

const connect = async () =>
  await Effect.runPromise(WireClient.make({ role: "cli", token: TEST_TOKEN, url: world.url }));

/** A polling assertion that gave up (the async fork hadn't landed in time). */
// Aliased so the TaggedError class declaration below stays a plain call
// (`new` breaks the schema typecheck — `TaggedError` is a function
// returning a class, not a class).
const tagged = Schema.TaggedError;
class TestError extends tagged<TestError>()("TestError", {
  message: Schema.String,
}) {}

/** Poll until `fn` holds (hub event forks + agent stream land asynchronously). */
const waitFor = (fn: () => boolean | Promise<boolean>, timeoutMs = 3000) =>
  Effect.gen(function* poll() {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const done = yield* Effect.promise(async () => await fn());
      if (done) {
        return;
      }
      yield* Effect.sleep("5 millis");
    }
    yield* Effect.fail(new TestError({ message: "condition not met" }));
  });

describe("hub + real SessionHost over the wire", () => {
  it("runs a real prompt: lazy reads, streamed events, state broadcasts, durable entries", async () => {
    const client = await connect();
    await Effect.runPromise(client.connect());
    const events: { type: string }[] = [];
    const changed: ThreadInfo[] = [];
    client.on("event", (e) => {
      events.push({ type: e.event.type });
    });
    client.on("thread_changed", (thread) => {
      changed.push(thread);
    });

    // The thread's real session id is the thread id; the host creates its
    // own trail under SAKU_HOME (the adapter's record mirrors the hub's).
    const thread = await Effect.runPromise(client.createThread("quick start", { autoName: true }));
    expect(thread.env).toBe("ready");

    // Reads before any prompt answer without starting the session.
    const before = await Effect.runPromise(client.getState(thread.id));
    expect(before).toMatchObject({ sessionId: null, state: "idle", tailSeq: 0 });
    const entriesBefore = await Effect.runPromise(client.getEntries(thread.id));
    expect(entriesBefore.entries).toHaveLength(0);

    // A prompt runs the real host: entry + settled events, working → idle.
    await Effect.runPromise(client.prompt(thread.id, "hello"));
    await Effect.runPromise(waitFor(() => events.some((e) => e.type === "entry_appended")));
    await Effect.runPromise(waitFor(() => events.some((e) => e.type === "settled")));
    await Effect.runPromise(
      waitFor(() => changed.some((t) => t.id === thread.id && t.state === "working")),
    );
    await Effect.runPromise(
      waitFor(() => changed.some((t) => t.id === thread.id && t.state === "idle")),
    );
    expect(events.map((e) => e.type)).toContain("settled");

    // The durable trail: the run's entries are readable through the hub.
    const { entries, tailSeq, leafId } = await Effect.runPromise(client.getEntries(thread.id));
    expect(entries.map((entry) => entry.type)).toEqual([
      "model_change",
      "thinking_level_change",
      "message",
      "message",
    ]);
    expect(
      entries.filter((entry) => entry.type === "message").map((entry) => entry.message.role),
    ).toEqual(["user", "assistant"]);
    expect(tailSeq).toBe(4);
    expect(leafId).not.toBeNull();

    // The session state: stable sessionId (back-filled via the hub's report
    // channel), the catalog's default model, the thread's tailSeq.
    const state = await Effect.runPromise(client.getState(thread.id));
    expect(state.sessionId).toBe(thread.id);
    expect(state.model).toMatchObject({ id: TEST_MODEL, provider: TEST_PROVIDER });
    expect(state.tailSeq).toBe(4);
    // The hub's registry view carries the same sessionId and tailSeq.
    const info = await Effect.runPromise(client.getThread(thread.id));
    expect(info).toMatchObject({ sessionId: thread.id, state: "idle", tailSeq: 4 });
  });

  it("reports the auto-title to the hub and applies it to the registry name", async () => {
    // This suite's catalog feeds the host's auto-title completion.
    const client = await connect();
    await Effect.runPromise(client.connect());
    const thread = await Effect.runPromise(client.createThread("quick start", { autoName: true }));
    await Effect.runPromise(client.prompt(thread.id, "hello"));
    await Effect.runPromise(
      waitFor(async () => {
        const info = await Effect.runPromise(client.getThread(thread.id));
        return info.name.startsWith("a canned completion");
      }, 5000),
    );
    const renamed = await Effect.runPromise(client.getThread(thread.id));
    expect(renamed.name).toContain("quick start");
  });

  it("deletes the thread, its session, and its trail", async () => {
    const client = await connect();
    await Effect.runPromise(client.connect());
    const thread = await Effect.runPromise(client.createThread("gone soon"));
    await Effect.runPromise(client.prompt(thread.id, "hello"));
    await Effect.runPromise(client.deleteThread(thread.id));
    expect(await Effect.runPromise(client.listThreads())).toHaveLength(0);
    // The trail directory is gone with the thread.
    const trailExists = await Effect.runPromise(
      world.fs
        .exists(world.paths.threadTrailRoot(thread.id))
        .pipe(Effect.catch(() => Effect.succeed(false))),
    );
    expect(trailExists).toBe(false);
  });

  it("provisions a sandbox thread on first prompt (scripted provisioner)", async () => {
    const client = await connect();
    await Effect.runPromise(client.connect());
    const thread = await Effect.runPromise(client.createThread("boxed", { mode: "sandbox" }));
    expect(thread.env).toBe("stopped");
    // The scripted provisioner succeeds; the real SessionHost runs the run
    // with its stub stream fn, then the thread settles back to idle.
    await Effect.runPromise(client.prompt(thread.id, "hi"));
    const info = await Effect.runPromise(client.getThread(thread.id));
    expect(info.env).toBe("ready");
    expect(info.state).toBe("idle");
  });
});
