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
import { Effect, Exit, FileSystem, Scope } from "effect";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { getThreadTrailRoot } from "@saku/worker";
import { KvStore } from "@saku/store";
import { makeWireClient, type ThreadInfo, type WireClient } from "@saku/wire";

import { makeHub, makeHubRegistry, makeHubServer, makeSkillsStore } from "../src/index.ts";
import { inProcessWorker } from "./in-process-worker.ts";
import { scriptedProvisioner } from "./mock-worker.ts";
import {
  assistantMessage,
  fakeCatalog,
  TEST_MODEL,
  TEST_PROVIDER,
} from "../../worker/test/fakes.ts";

const TEST_TOKEN = "hub-test-secret";

const run = <A, E extends Error>(effect: Effect.Effect<A, E, never>): Promise<A> =>
  Effect.runPromise(effect);

/** A scripted stream that emits one assistant message immediately. */
const oneShotStream = (text: string): StreamFn => {
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
  readonly home: string;
  readonly scope: Scope.Scope;
}

let world: World;

/** The catalog + scripted stream + stub env the suites run on. */
const workerCatalog = (completions: string[] = []) => fakeCatalog({ completions });

beforeEach(async () => {
  const { fs, home, url, scope } = await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectory({ prefix: "saku-hub-real-" });
      process.env.SAKU_HOME = home;
      const registry = yield* makeHubRegistry().pipe(Effect.provide(KvStore.memory()));
      const skills = yield* makeSkillsStore().pipe(Effect.provide(KvStore.memory()));
      const worker = yield* inProcessWorker({
        fs,
        catalog: workerCatalog(),
        streamFn: oneShotStream("a canned response"),
      });
      const hub = yield* makeHub({
        registry,
        skills,
        workerRef: worker.ref,
        provisioner: scriptedProvisioner(),
      });
      worker.attach(hub.events);
      const server = yield* makeHubServer({ hub, token: TEST_TOKEN }).pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      return { fs, home, url: server.url, scope };
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
  world = { url, fs, home, scope };
});

afterEach(async () => {
  delete process.env.SAKU_HOME;
  await Effect.runPromise(Scope.close(world.scope, Exit.void));
  await Effect.runPromise(
    Effect.provide(NodeFileSystem.layer)(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs
          .remove(world.home, { recursive: true, force: true })
          .pipe(Effect.catch(() => Effect.void));
      }),
    ),
  );
});

const connect = (): Promise<WireClient> =>
  run(makeWireClient({ url: world.url, token: TEST_TOKEN, role: "cli" }));

/** Poll until `fn` holds (hub event forks + agent stream land asynchronously). */
const waitFor = async (fn: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition not met");
};

describe("hub + real SessionHost over the wire", () => {
  it("runs a real prompt: lazy reads, streamed events, state broadcasts, durable entries", async () => {
    const client = await connect();
    await run(client.connect());
    const events: Array<{ type: string }> = [];
    const changed: ThreadInfo[] = [];
    client.on("event", (e) => events.push({ type: e.event.type }));
    client.on("thread_changed", (thread) => changed.push(thread));

    // The thread's real session id is the thread id; the host creates its
    // own trail under SAKU_HOME (the adapter's record mirrors the hub's).
    const thread = await run(client.createThread("quick start", { autoName: true }));
    expect(thread.env).toBe("ready");

    // Reads before any prompt answer without starting the session.
    const before = await run(client.getState(thread.id));
    expect(before).toMatchObject({ sessionId: null, state: "idle", tailSeq: 0 });
    const entriesBefore = await run(client.getEntries(thread.id));
    expect(entriesBefore.entries).toHaveLength(0);

    // A prompt runs the real host: entry + settled events, working → idle.
    await run(client.prompt(thread.id, "hello"));
    await waitFor(() => events.some((e) => e.type === "entry_appended"));
    await waitFor(() => events.some((e) => e.type === "settled"));
    await waitFor(() => changed.some((t) => t.id === thread.id && t.state === "working"));
    await waitFor(() => changed.some((t) => t.id === thread.id && t.state === "idle"));
    expect(events.map((e) => e.type)).toContain("settled");

    // The durable trail: the run's entries are readable through the hub.
    const { entries, tailSeq, leafId } = await run(client.getEntries(thread.id));
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
    const state = await run(client.getState(thread.id));
    expect(state.sessionId).toBe(thread.id);
    expect(state.model).toMatchObject({ provider: TEST_PROVIDER, id: TEST_MODEL });
    expect(state.tailSeq).toBe(4);
    // The hub's registry view carries the same sessionId and tailSeq.
    const info = await run(client.getThread(thread.id));
    expect(info).toMatchObject({ sessionId: thread.id, tailSeq: 4, state: "idle" });
  });

  it("reports the auto-title to the hub and applies it to the registry name", async () => {
    // This suite's catalog feeds the host's auto-title completion.
    const client = await connect();
    await run(client.connect());
    const thread = await run(client.createThread("quick start", { autoName: true }));
    await run(client.prompt(thread.id, "hello"));
    await waitFor(
      async () => (await run(client.getThread(thread.id))).name.startsWith("a canned completion"),
      5000,
    );
    const renamed = await run(client.getThread(thread.id));
    expect(renamed.name).toContain("quick start");
  });

  it("deletes the thread, its session, and its trail", async () => {
    const client = await connect();
    await run(client.connect());
    const thread = await run(client.createThread("gone soon"));
    await run(client.prompt(thread.id, "hello"));
    await run(client.deleteThread(thread.id));
    expect(await run(client.listThreads())).toHaveLength(0);
    // The trail directory is gone with the thread.
    const trailExists = await run(
      world.fs
        .exists(getThreadTrailRoot(thread.id))
        .pipe(Effect.catch(() => Effect.succeed(false))),
    );
    expect(trailExists).toBe(false);
  });

  it("provisions a sandbox thread on first prompt (scripted provisioner)", async () => {
    const client = await connect();
    await run(client.connect());
    const thread = await run(client.createThread("boxed", { mode: "sandbox" }));
    expect(thread.env).toBe("stopped");
    // The scripted provisioner succeeds; the real SessionHost runs the run
    // with its stub stream fn, then the thread settles back to idle.
    await run(client.prompt(thread.id, "hi"));
    const info = await run(client.getThread(thread.id));
    expect(info.env).toBe("ready");
    expect(info.state).toBe("idle");
  });
});
