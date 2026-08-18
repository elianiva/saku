/**
 * Hub wire integration tests: the full stack — wire client ⇄ hub server ⇄
 * hub core ⇄ scripted worker — over real WebSockets. Handshake auth
 * (token, version), command routing, thread_changed + session-event
 * fan-out to multiple consoles, the env gate, and skills.
 *
 * The real-SessionHost integration (in-process-worker.ts) covers the other
 * half; this suite keeps the hub's protocol behavior deterministic.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Effect, Exit, Result, Schema, Scope } from "effect";

import { KvStore } from "@saku/store";
import {
  WIRE_VERSION,
  decodeFrame,
  WireClient,
  parseFrame,
  serializeFrame,
  Hello,
  WireCommand,
} from "@saku/wire";
import type { JsonValue, ThreadInfo, WireClientApi, WorkerClientOptions } from "@saku/wire";

import { HubError, Hub, HubRegistry, HubServer, SkillsStore } from "../src/index.ts";
import { scriptedProvisioner, scriptedWorker } from "./mock-worker.ts";
import type { ScriptedWorker } from "./mock-worker.ts";

const TEST_TOKEN = "hub-test-secret";

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
      const registry = yield* HubRegistry.make().pipe(Effect.provide(KvStore.memory()));
      const skills = yield* SkillsStore.make().pipe(Effect.provide(KvStore.memory()));
      const worker = scriptedWorker();
      const hub = yield* Hub.make({
        provisioner: scriptedProvisioner({ fail: true }),
        registry,
        skills,
        workerRef: worker.ref,
      });
      worker.attach(hub.events);
      const server = yield* HubServer.make({ hub, token: TEST_TOKEN }).pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      return { scope, url: server.url, worker };
    }),
  );
  seq = 0;
});

afterEach(async () => {
  await Effect.runPromise(Scope.close(world.scope, Exit.void));
});

const connect = async (options?: Partial<WorkerClientOptions>) =>
  await Effect.runPromise(
    WireClient.make({ role: "cli", token: TEST_TOKEN, url: world.url, ...options }),
  );

const newThread = async (client: WireClientApi, name?: string) => {
  seq += 1;
  const threadName = name ?? `thread ${seq}`;
  return await Effect.runPromise(client.createThread(threadName));
};

/** A raw socket (no client machinery) for protocol-level assertions. */
const rawSocket = () =>
  Effect.callback<WebSocket, Error>((resume) => {
    const socket = new WebSocket(world.url);
    socket.on("open", () => {
      resume(Effect.succeed(socket));
    });
    socket.on("error", (error) => {
      resume(Effect.fail(error));
    });
  });

/** The frame fields this suite's protocol assertions read. */
interface FrameLog {
  readonly _tag: string;
  readonly error?: JsonValue;
  readonly message?: JsonValue;
  readonly ok?: boolean;
}

/** Narrow a parsed frame to the object shape the assertions read. */
const isFrameLog = (value: JsonValue | undefined): value is JsonValue & FrameLog =>
  value !== undefined && typeof value === "object" && value !== null;

/** Collect every frame the server sends on a raw socket, from now on. */
const frameLog = async (socket: WebSocket) => {
  const frames: FrameLog[] = [];
  socket.on("message", (data) => {
    const parsed = Result.try(() => parseFrame(decodeFrame(data)));
    if (Result.isSuccess(parsed) && isFrameLog(parsed.success)) {
      frames.push(parsed.success);
    }
  });
  await sleep(150);
  return frames;
};

/** Poll until `fn` holds (the hub's event forks land asynchronously). */
// Aliased so the TaggedError class declaration below stays a plain call
// (`new` breaks the schema typecheck — `TaggedError` is a function
// returning a class, not a class).
const tagged = Schema.TaggedError;
class TestError extends tagged<TestError>()("TestError", {
  message: Schema.String,
}) {}

const waitFor = (fn: () => boolean, timeoutMs = 2000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (fn()) {
        return;
      }
      yield* Effect.sleep("5 millis");
    }
    yield* Effect.fail(new TestError({ message: "condition not met" }));
  });

describe("handshake", () => {
  it("completes and reports the wire version", async () => {
    const client = await connect();
    const hello = await Effect.runPromise(client.connect());
    expect(hello.version).toBe(WIRE_VERSION);
    expect(hello.pid).toBeTypeOf("number");
    client.disconnect();
  });

  it("rejects a bad token", async () => {
    const client = await connect({ token: "wrong" });
    await expect(Effect.runPromise(client.connect())).rejects.toMatchObject({
      code: "handshake",
      message: "invalid token",
    });
  });

  it("rejects a version mismatch before anything else", async () => {
    const client = await connect({ version: "0.0.0" });
    await expect(Effect.runPromise(client.connect())).rejects.toMatchObject({
      code: "handshake",
      message: `version mismatch: expected ${WIRE_VERSION}`,
    });
  });

  it("rejects commands before hello", async () => {
    const socket = await Effect.runPromise(rawSocket());
    const frames = frameLog(socket);
    socket.send(serializeFrame(WireCommand.make({ command: { _tag: "list_threads" }, id: "r1" })));
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
    await Effect.runPromise(a.connect());
    await Effect.runPromise(b.connect());
    const changed: ThreadInfo[] = [];
    a.on("thread_changed", (thread) => {
      changed.push(thread);
    });
    b.on("thread_changed", (thread) => {
      changed.push(thread);
    });

    const thread = await newThread(a, "alpha");
    expect(thread).toMatchObject({ env: "ready", mode: "local", name: "alpha" });
    expect(world.worker.created).toEqual([thread.id]);
    // Both consoles saw the create.
    await Effect.runPromise(waitFor(() => changed.length === 2));

    const listed = await Effect.runPromise(a.listThreads());
    expect(listed.map((t) => t.id)).toEqual([thread.id]);
    const fetched = await Effect.runPromise(b.getThread(thread.id));
    expect(fetched.id).toBe(thread.id);

    const renamed = await Effect.runPromise(a.renameThread(thread.id, "beta"));
    expect(renamed.name).toBe("beta");
    await Effect.runPromise(waitFor(() => changed.length === 4));
    expect(changed.at(-1)?.name).toBe("beta");

    await Effect.runPromise(b.deleteThread(thread.id));
    await Effect.runPromise(waitFor(() => changed.length === 6));
    expect(world.worker.deleted).toEqual([thread.id]);
    expect(await Effect.runPromise(a.listThreads())).toHaveLength(0);
  });

  it("fails an unknown thread with a response error", async () => {
    const client = await connect();
    await Effect.runPromise(client.connect());
    await expect(Effect.runPromise(client.getThread("nope"))).rejects.toMatchObject({
      code: "command_failed",
      message: 'no thread matches "nope"',
    });
  });
});

describe("session commands over the wire", () => {
  it("streams a run's events and state changes to every console", async () => {
    const a = await connect();
    const b = await connect();
    await Effect.runPromise(a.connect());
    await Effect.runPromise(b.connect());
    const sessionEvents: { threadId: string; event: { type: string } }[] = [];
    const changed: { id: string; state: string; tailSeq: number }[] = [];
    a.on("event", (e) => {
      sessionEvents.push(e);
    });
    b.on("event", (e) => {
      sessionEvents.push(e);
    });
    a.on("thread_changed", (thread) => {
      changed.push(thread);
    });
    b.on("thread_changed", (thread) => {
      changed.push(thread);
    });

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
          entry: { id: "e1", text: command.text, type: "user_message" },
          type: "entry_appended",
        },
        3,
      );
      world.worker.emit(threadId, { type: "settled" }, 3);
      world.worker.report(threadId, { state: "idle" });
      return Effect.succeed({ payload: { _tag: "prompt" }, tailSeq: 3 });
    });
    await Effect.runPromise(a.prompt(thread.id, "hello"));

    // Both consoles see both session events (4 total) and the run's reports.
    await Effect.runPromise(waitFor(() => sessionEvents.length === 4));
    await Effect.runPromise(
      waitFor(() => changed.some((t) => t.id === thread.id && t.state === "working")),
    );
    await Effect.runPromise(
      waitFor(() => changed.some((t) => t.id === thread.id && t.state === "idle")),
    );
    const eventTypes = sessionEvents.map((e) => e.event.type);
    expect(eventTypes.filter((type) => type === "entry_appended")).toHaveLength(2);
    expect(eventTypes.filter((type) => type === "settled")).toHaveLength(2);
    // The last broadcast carries the run's tailSeq.
    const ofThread = changed.filter((t) => t.id === thread.id);
    const last = ofThread.at(-1);
    expect(last?.state).toBe("idle");
    expect(last?.tailSeq).toBe(3);
  });

  it("gates sandbox prompts: provisioning failure is a response error, env → error", async () => {
    const client = await connect();
    await Effect.runPromise(client.connect());
    const changed: ThreadInfo[] = [];
    client.on("thread_changed", (thread) => {
      changed.push(thread);
    });

    // A sandbox thread: the env axis starts stopped (lazy provisioning).
    const sandbox = await Effect.runPromise(client.createThread("sandboxed", { mode: "sandbox" }));
    expect(sandbox.env).toBe("stopped");

    // This suite's hub carries a failing provisioner: the prompt is refused
    // before it reaches the worker, and the env axis flips to error.
    await expect(Effect.runPromise(client.prompt(sandbox.id, "hi"))).rejects.toMatchObject({
      code: "command_failed",
      message: "sandbox provisioning failed (scripted)",
    });
    await Effect.runPromise(
      waitFor(() => changed.some((t) => t.id === sandbox.id && t.env === "error")),
    );
    // Reads bypass the gate: browsing a failed sandbox still answers.
    const state = await Effect.runPromise(client.getState(sandbox.id));
    expect(state.state).toBe("idle");
  });

  it("rejects a session command without a threadId", async () => {
    const socket = await Effect.runPromise(rawSocket());
    const frames = frameLog(socket);
    socket.send(
      serializeFrame(Hello.make({ role: "cli", token: TEST_TOKEN, version: WIRE_VERSION })),
    );
    await sleep(50);
    socket.send(serializeFrame(WireCommand.make({ command: { _tag: "get_state" }, id: "r2" })));
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
    await Effect.runPromise(client.connect());
    const skill = await Effect.runPromise(client.importSkill("https://github.com/foo/bar-baz.git"));
    expect(skill).toMatchObject({ name: "bar-baz", scope: "personal" });
    const workspace = await Effect.runPromise(
      client.importSkill("https://github.com/foo/team.git", "workspace"),
    );
    expect(workspace.scope).toBe("workspace");
    const skills = await Effect.runPromise(client.listSkills());
    expect(skills.map((s) => s.name)).toEqual(["bar-baz", "team"]);
    await Effect.runPromise(client.deleteSkill(skill.id));
    await expect(Effect.runPromise(client.deleteSkill(skill.id))).rejects.toMatchObject({
      code: "command_failed",
      message: `unknown skill: ${skill.id}`,
    });
  });
});
