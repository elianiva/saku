/**
 * Hub wire integration tests: the full stack — wire client ⇄ hub server ⇄
 * hub core ⇄ scripted worker — over real WebSockets. Handshake auth
 * (token, version), command routing, thread_changed + session-event
 * fan-out to multiple consoles, the env gate, and skills.
 *
 * The real-SessionHost integration (in-process-worker.ts) covers the other
 * half; this suite keeps the hub's protocol behavior deterministic.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Effect, Exit, Result, Schema, Scope } from "effect";

import { KvStore } from "@saku/store";
import {
  WIRE_VERSION,
  decodeFrame,
  makeWireClient,
  parseFrame,
  serializeFrame,
  type ThreadInfo,
  type WireClient,
  type WorkerClientOptions,
} from "@saku/wire";
import { Hello, WireCommand } from "@saku/wire";

import {
  HubError,
  makeHub,
  makeHubRegistry,
  makeHubServer,
  makeSkillsStore,
} from "../src/index.ts";
import { scriptedProvisioner, scriptedWorker, type ScriptedWorker } from "./mock-worker.ts";

const TEST_TOKEN = "hub-test-secret";

const run = <A, E extends Error>(effect: Effect.Effect<A, E, never>) =>
  Effect.runPromise(effect);

interface World {
  readonly url: string;
  readonly worker: ScriptedWorker;
  readonly scope: Scope.Scope;
}

let world: World;
let seq = 0;

beforeEach(async () => {
  world = await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const registry = yield* makeHubRegistry().pipe(Effect.provide(KvStore.memory()));
      const skills = yield* makeSkillsStore().pipe(Effect.provide(KvStore.memory()));
      const worker = scriptedWorker();
      const hub = yield* makeHub({
        registry,
        skills,
        workerRef: worker.ref,
        provisioner: scriptedProvisioner({ fail: true }),
      });
      worker.attach(hub.events);
      const server = yield* makeHubServer({ hub, token: TEST_TOKEN }).pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      return { url: server.url, worker, scope };
    }),
  );
  seq = 0;
});

afterEach(async () => {
  await Effect.runPromise(Scope.close(world.scope, Exit.void));
});

const connect = (options?: Partial<WorkerClientOptions>) =>
  run(makeWireClient({ url: world.url, token: TEST_TOKEN, role: "cli", ...options }));

const newThread = async (client: WireClient, name = `thread ${++seq}`) =>
  run(client.createThread(name));

/** A raw socket (no client machinery) for protocol-level assertions. */
const rawSocket = (): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(world.url);
    socket.on("open", () => resolve(socket));
    socket.on("error", reject);
  });

/** Collect every frame the server sends on a raw socket, from now on. */
const frameLog = (socket: WebSocket): Promise<Array<Record<string, unknown>>> => {
  const frames: Array<Record<string, unknown>> = [];
  socket.on("message", (data) => {
    const parsed = Result.try(() => parseFrame(decodeFrame(data)));
    if (Result.isSuccess(parsed) && parsed.success !== undefined) {
      frames.push(parsed.success as Record<string, unknown>);
    }
  });
  return new Promise((resolve) => setTimeout(() => resolve(frames), 150));
};

/** Poll until `fn` holds (the hub's event forks land asynchronously). */
class TestError extends Schema.TaggedError<TestError>()("TestError", {
  message: Schema.String,
}) {}

const waitFor = async (fn: () => boolean, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new TestError({ message: "condition not met" });
};

describe("handshake", () => {
  it("completes and reports the wire version", async () => {
    const client = await connect();
    const hello = await run(client.connect());
    expect(hello.version).toBe(WIRE_VERSION);
    expect(hello.pid).toBeTypeOf("number");
    client.disconnect();
  });

  it("rejects a bad token", async () => {
    const client = await connect({ token: "wrong" });
    await expect(run(client.connect())).rejects.toMatchObject({
      code: "handshake",
      message: "invalid token",
    });
  });

  it("rejects a version mismatch before anything else", async () => {
    const client = await connect({ version: "0.0.0" });
    await expect(run(client.connect())).rejects.toMatchObject({
      code: "handshake",
      message: `version mismatch: expected ${WIRE_VERSION}`,
    });
  });

  it("rejects commands before hello", async () => {
    const socket = await rawSocket();
    const frames = frameLog(socket);
    socket.send(serializeFrame(WireCommand.make({ id: "r1", command: { _tag: "list_threads" } })));
    const log = await frames;
    expect(log.some((frame) => frame._tag === "error" && frame.message === "hello first")).toBe(
      true,
    );
    socket.close();
  });
});

describe("thread lifecycle over the wire", () => {
  it("creates, lists, gets, renames, and deletes, broadcasting to all consoles", async () => {
    const a = await connect();
    const b = await connect();
    await run(a.connect());
    await run(b.connect());
    const changed: ThreadInfo[] = [];
    a.on("thread_changed", (thread) => changed.push(thread));
    b.on("thread_changed", (thread) => changed.push(thread));

    const thread = await newThread(a, "alpha");
    expect(thread).toMatchObject({ name: "alpha", mode: "local", env: "ready" });
    expect(world.worker.created).toEqual([thread.id]);
    await waitFor(() => changed.length === 2); // both consoles saw the create

    expect((await run(a.listThreads())).map((t) => t.id)).toEqual([thread.id]);
    expect((await run(b.getThread(thread.id))).id).toBe(thread.id);

    const renamed = await run(a.renameThread(thread.id, "beta"));
    expect(renamed.name).toBe("beta");
    await waitFor(() => changed.length === 4);
    expect(changed.at(-1)?.name).toBe("beta");

    await run(b.deleteThread(thread.id));
    await waitFor(() => changed.length === 6);
    expect(world.worker.deleted).toEqual([thread.id]);
    expect(await run(a.listThreads())).toHaveLength(0);
  });

  it("fails an unknown thread with a response error", async () => {
    const client = await connect();
    await run(client.connect());
    await expect(run(client.getThread("nope"))).rejects.toMatchObject({
      code: "command_failed",
      message: 'no thread matches "nope"',
    });
  });
});

describe("session commands over the wire", () => {
  it("streams a run's events and state changes to every console", async () => {
    const a = await connect();
    const b = await connect();
    await run(a.connect());
    await run(b.connect());
    const sessionEvents: Array<{ threadId: string; event: { type: string } }> = [];
    const changed: Array<{ id: string; state: string; tailSeq: number }> = [];
    a.on("event", (e) => sessionEvents.push(e));
    b.on("event", (e) => sessionEvents.push(e));
    a.on("thread_changed", (thread) => changed.push(thread));
    b.on("thread_changed", (thread) => changed.push(thread));

    const thread = await newThread(a, "runner");
    world.worker.onCommand((threadId, command) => {
      if (command._tag !== "prompt") {
        return Effect.fail(
          new HubError({ kind: "command", message: `unscripted: ${command._tag}` }),
        );
      }
      world.worker.report(threadId, { state: "working" });
      world.worker.emit(
        threadId,
        {
          type: "entry_appended",
          entry: { id: "e1", type: "user_message", text: command.text },
        } as never,
        3,
      );
      world.worker.emit(threadId, { type: "settled" }, 3);
      world.worker.report(threadId, { state: "idle" });
      return Effect.succeed({ payload: { _tag: "prompt" }, tailSeq: 3 });
    });
    await run(a.prompt(thread.id, "hello"));

    // Both consoles see both session events (4 total) and the run's reports.
    await waitFor(() => sessionEvents.length === 4);
    await waitFor(() => changed.some((t) => t.id === thread.id && t.state === "working"));
    await waitFor(() => changed.some((t) => t.id === thread.id && t.state === "idle"));
    expect(sessionEvents.map((e) => e.event.type).sort()).toEqual([
      "entry_appended",
      "entry_appended",
      "settled",
      "settled",
    ]);
    // The last broadcast carries the run's tailSeq.
    const last = changed.filter((t) => t.id === thread.id).at(-1);
    expect(last?.state).toBe("idle");
    expect(last?.tailSeq).toBe(3);
  });

  it("gates sandbox prompts: provisioning failure is a response error, env → error", async () => {
    const client = await connect();
    await run(client.connect());
    const changed: ThreadInfo[] = [];
    client.on("thread_changed", (thread) => changed.push(thread));

    // A sandbox thread: the env axis starts stopped (lazy provisioning).
    const sandbox = await run(client.createThread("sandboxed", { mode: "sandbox" }));
    expect(sandbox.env).toBe("stopped");

    // This suite's hub carries a failing provisioner: the prompt is refused
    // before it reaches the worker, and the env axis flips to error.
    await expect(run(client.prompt(sandbox.id, "hi"))).rejects.toMatchObject({
      code: "command_failed",
      message: "sandbox provisioning failed (scripted)",
    });
    await waitFor(() => changed.some((t) => t.id === sandbox.id && t.env === "error"));
    // Reads bypass the gate: browsing a failed sandbox still answers.
    const state = await run(client.getState(sandbox.id));
    expect(state.state).toBe("idle");
  });

  it("rejects a session command without a threadId", async () => {
    const socket = await rawSocket();
    const frames = frameLog(socket);
    socket.send(
      serializeFrame(Hello.make({ token: TEST_TOKEN, role: "cli", version: WIRE_VERSION })),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.send(serializeFrame(WireCommand.make({ id: "r2", command: { _tag: "get_state" } })));
    const log = await frames;
    expect(
      log.some(
        (frame) =>
          frame._tag === "response" &&
          frame.ok === false &&
          frame.error === "session command without a threadId",
      ),
    ).toBe(true);
    socket.close();
  });
});

describe("skills over the wire", () => {
  it("imports, lists, and deletes skills", async () => {
    const client = await connect();
    await run(client.connect());
    const skill = await run(client.importSkill("https://github.com/foo/bar-baz.git"));
    expect(skill).toMatchObject({ name: "bar-baz", scope: "personal" });
    const workspace = await run(client.importSkill("https://github.com/foo/team.git", "workspace"));
    expect(workspace.scope).toBe("workspace");
    const skills = await run(client.listSkills());
    expect(skills.map((s) => s.name)).toEqual(["bar-baz", "team"]);
    await run(client.deleteSkill(skill.id));
    await expect(run(client.deleteSkill(skill.id))).rejects.toMatchObject({
      code: "command_failed",
      message: `unknown skill: ${skill.id}`,
    });
  });
});
