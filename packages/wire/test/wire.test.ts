/**
 * The wire's integration tests: the whole protocol proven end to end
 * against the shipped server implementation — `WireServer.make` (the same
 * core the hub and the local daemon run) over a real WebSocket server, via
 * a scripted in-memory fixture.
 *
 * Covered: handshake (hello/version/token), malformed and undecodable
 * frames, request/response correlation, dispatch of every command to its
 * handler, thread lifecycle, session commands, skills, event fan-out
 * (thread_changed + session events), timeouts, disconnects, server close,
 * and reconnect. The wire is the integration seam of the whole system
 * (ADR 0004); these tests are its contract.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import fc from "fast-check";

import {
  Hello,
  WIRE_VERSION,
  decodeFrame,
  WireClient,
  parseFrame,
  serializeFrame,
  WireError,
  type WireClientShape,
  type WorkerClientOptions,
} from "../src/index.ts";
import { MOCK_MODEL, startHubFixture, TEST_TOKEN, type HubFixture } from "./hub-fixture.ts";

/** The test file's own failure type (house style: tagged, even in tests). */
class TestError extends Schema.TaggedError<TestError>()("TestError", {
  kind: Schema.Literals(["raw_open_failed"]),
  message: Schema.String,
}) {}

const wait = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

let hub: HubFixture;
let seq = 0;

beforeEach(async () => {
  hub = await Effect.runPromise(startHubFixture());
  seq = 0;
});

afterEach(async () => {
  await Effect.runPromise(hub.close());
});

const connect = (options?: Partial<WorkerClientOptions>) =>
  Effect.runPromise(WireClient.make({ url: hub.url, token: TEST_TOKEN, role: "cli", ...options }));

const newThread = async (client: WireClientShape, name = `thread ${++seq}`) => {
  const thread = await Effect.runPromise(client.createThread(name, { cwd: "/tmp/work" }));
  return thread.id;
};

/** A raw (non-wire-client) WebSocket for the server-robustness tests. */
const rawClient = async () => {
  const socket = new WebSocket(hub.url);
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () =>
      reject(new TestError({ kind: "raw_open_failed", message: "raw client could not open" }));
  });
  return socket;
};

/** Collect the frames a raw socket receives, decoded. */
const collectFrames = (socket: WebSocket) => {
  const frames: unknown[] = [];
  socket.onmessage = (message) => frames.push(parseFrame(decodeFrame(message.data)));
  return frames;
};

/** Whether a decoded frame is a tagged object (has a `_tag` discriminant). */
const isTaggedFrame = (frame: unknown): frame is { readonly _tag: string } =>
  typeof frame === "object" && frame !== null && "_tag" in frame;

/** The `_tag` of a decoded frame, for order-insensitive assertions. */
const tagOf = (frame: unknown) => (isTaggedFrame(frame) ? frame._tag : undefined);

describe("handshake", () => {
  it("completes and reports the wire version", async () => {
    const client = await connect();
    const hello = await Effect.runPromise(client.connect());
    expect(hello.version).toBe(WIRE_VERSION);
    expect(hello.pid).toBeTypeOf("number");
    await Effect.runPromise(client.disconnect());
  });

  it("rejects a bad token", async () => {
    const client = await connect({ token: "wrong" });
    await expect(Effect.runPromise(client.connect())).rejects.toMatchObject({
      code: "handshake",
      message: "invalid token",
    });
    await Effect.runPromise(client.disconnect());
  });

  it("rejects a version mismatch before anything else", async () => {
    const client = await connect({ version: "0.0.0" });
    await expect(Effect.runPromise(client.connect())).rejects.toMatchObject({
      code: "handshake",
      message: `version mismatch: expected ${WIRE_VERSION}`,
    });
    await Effect.runPromise(client.disconnect());
  });

  it("fails with refused when nothing is listening", async () => {
    const client = await connect({ url: "ws://127.0.0.1:1" });
    await expect(Effect.runPromise(client.connect())).rejects.toMatchObject({ code: "refused" });
    await Effect.runPromise(client.disconnect());
  });
});

describe("thread lifecycle", () => {
  it("creates, lists, gets, renames, and deletes threads", async () => {
    const client = await connect();
    await Effect.runPromise(client.connect());
    const id = await newThread(client, "alpha");

    const threads = await Effect.runPromise(client.listThreads());
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      name: "alpha",
      cwd: "/tmp/work",
      state: "idle",
      env: "ready",
    });

    const got = await Effect.runPromise(client.getThread(id));
    expect(got.id).toBe(id);

    const renamed = await Effect.runPromise(client.renameThread(id, "beta"));
    expect(renamed.name).toBe("beta");

    await Effect.runPromise(client.deleteThread(id));
    expect(await Effect.runPromise(client.listThreads())).toHaveLength(0);
    await Effect.runPromise(client.disconnect());
  });

  it("sends thread_changed on every mutation", async () => {
    const client = await connect();
    await Effect.runPromise(client.connect());
    const changes: string[] = [];
    client.on("thread_changed", (thread) => changes.push(thread.name));

    await Effect.runPromise(client.createThread("first", {}));
    await Effect.runPromise(client.createThread("second", {}));
    expect(changes).toEqual(["first", "second"]);
    await Effect.runPromise(client.disconnect());
  });

  it("archives and unarchives a thread (visibility-only)", async () => {
    const client = await connect();
    await Effect.runPromise(client.connect());
    const id = await newThread(client, "alpha");

    const archived = await Effect.runPromise(client.archiveThread(id));
    expect(archived.archivedAt).not.toBeNull();

    const unarchived = await Effect.runPromise(client.unarchiveThread(id));
    expect(unarchived.archivedAt).toBeNull();
    expect(unarchived.name).toBe("alpha");

    await Effect.runPromise(client.disconnect());
  });

  it("archiving an unknown thread fails command_failed", async () => {
    const client = await connect();
    await Effect.runPromise(client.connect());

    await expect(Effect.runPromise(client.archiveThread("nope"))).rejects.toMatchObject({
      code: "command_failed",
    });
    await Effect.runPromise(client.disconnect());
  });

  it("fails command_failed for unknown threads", async () => {
    const client = await connect();
    await Effect.runPromise(client.connect());
    await expect(Effect.runPromise(client.getThread("nope"))).rejects.toMatchObject({
      code: "command_failed",
      message: "unknown thread: nope",
    });
    await Effect.runPromise(client.disconnect());
  });
});

describe("session commands", () => {
  it("prompt appends entries, settles, and is readable back", async () => {
    const client = await connect();
    await Effect.runPromise(client.connect());
    const id = await newThread(client);

    const events: string[] = [];
    client.on("event", ({ event }) => events.push(event.type));

    await Effect.runPromise(client.prompt(id, "hello"));
    expect(events).toEqual(["entry_appended", "settled"]);

    const { entries, tailSeq, leafId } = await Effect.runPromise(client.getEntries(id));
    expect(entries).toHaveLength(1);
    expect(tailSeq).toBe(1);
    expect(leafId).toBe(entries[0]!.id);

    const state = await Effect.runPromise(client.getState(id));
    expect(state.state).toBe("idle");
    expect(state.sessionId).toBe(id);
    await Effect.runPromise(client.disconnect());
  });

  it("supports reads without ever creating a session", async () => {
    const client = await connect();
    await Effect.runPromise(client.connect());
    const id = await newThread(client);

    const { entries, tailSeq } = await Effect.runPromise(client.getEntries(id));
    expect(entries).toHaveLength(0);
    expect(tailSeq).toBe(0);
    const state = await Effect.runPromise(client.getState(id));
    expect(state.sessionId).toBeNull();
    await Effect.runPromise(client.disconnect());
  });

  it("serves models, thinking levels, and session stats", async () => {
    const client = await connect();
    await Effect.runPromise(client.connect());
    const id = await newThread(client);

    const models = await Effect.runPromise(client.getAvailableModels(id));
    expect(models).toEqual([MOCK_MODEL]);
    const levels = await Effect.runPromise(client.getAvailableThinkingLevels(id));
    expect(levels).toContain("high");

    await Effect.runPromise(client.setModel(id, "mock", "m1"));
    await Effect.runPromise(client.setThinkingLevel(id, "high"));
    await expect(Effect.runPromise(client.setModel(id, "mock", "nope"))).rejects.toMatchObject({
      code: "command_failed",
    });

    const stats = await Effect.runPromise(client.getSessionStats(id));
    expect(stats).toBeDefined();
    await Effect.runPromise(client.disconnect());
  });

  it("rejects a prompt while the agent is working", async () => {
    const client = await connect();
    await Effect.runPromise(client.connect());
    const id = await newThread(client);

    // The slow run is still in flight on the fixture's side when the second
    // prompt lands; the fixture rejects it like the hub does.
    const first = Effect.runPromise(client.prompt(id, SLOW_PROMPT));
    await expect(Effect.runPromise(client.prompt(id, "second"))).rejects.toMatchObject({
      code: "command_failed",
      message: "agent is already processing",
    });
    await first;
    await Effect.runPromise(client.disconnect());
  });

  it("fails session commands for unknown threads", async () => {
    const client = await connect();
    await Effect.runPromise(client.connect());
    await expect(Effect.runPromise(client.prompt("nope", "hi"))).rejects.toMatchObject({
      code: "command_failed",
      message: "unknown thread: nope",
    });
    await Effect.runPromise(client.disconnect());
  });

  it("branches to a past entry", async () => {
    const client = await connect();
    await Effect.runPromise(client.connect());
    const id = await newThread(client);
    await Effect.runPromise(client.prompt(id, "first"));
    const { entries } = await Effect.runPromise(client.getEntries(id));
    const leaf = await Effect.runPromise(client.branch(id, entries[0]!.id));
    expect(leaf).toBe(entries[0]!.id);
    await expect(Effect.runPromise(client.branch(id, "e99"))).rejects.toMatchObject({
      code: "command_failed",
    });
    await Effect.runPromise(client.disconnect());
  });

  it("round-trips every session command and dispatches each to its handler", async () => {
    const client = await connect();
    await Effect.runPromise(client.connect());
    const id = await newThread(client);

    await Effect.runPromise(client.steer(id, "stay on task"));
    await Effect.runPromise(client.followUp(id, "and then?"));
    await Effect.runPromise(client.setSteeringMode(id, "one-at-a-time"));
    await Effect.runPromise(client.setFollowUpMode(id, "one-at-a-time"));
    const compact = await Effect.runPromise(client.compact(id, "keep it short"));
    expect(compact.summary).toBe("mock");
    expect(compact.tokensBefore).toBe(0);
    await Effect.runPromise(client.setAutoCompaction(id, true));
    await Effect.runPromise(client.setSessionName(id, "my session"));
    expect((await Effect.runPromise(client.getState(id))).name).toBe("my session");
    await Effect.runPromise(client.setThinkingLevel(id, "high"));
    expect((await Effect.runPromise(client.getState(id))).thinkingLevel).toBe("high");
    await Effect.runPromise(client.abort(id));

    // Dispatch proof: every command kind reached its handler, in order.
    expect(hub.calls()).toEqual([
      "create_thread",
      "steer",
      "follow_up",
      "set_steering_mode",
      "set_follow_up_mode",
      "compact",
      "set_auto_compaction",
      "set_session_name",
      "get_state",
      "set_thinking_level",
      "get_state",
      "abort",
    ]);
    await Effect.runPromise(client.disconnect());
  });
});

describe("skills", () => {
  it("imports, lists, and deletes skills", async () => {
    const client = await connect();
    await Effect.runPromise(client.connect());

    const skill = await Effect.runPromise(client.importSkill("git@github.com:acme/dotfiles.git"));
    expect(skill).toMatchObject({
      name: "dotfiles",
      scope: "personal",
      source: "git@github.com:acme/dotfiles.git",
    });

    const workspace = await Effect.runPromise(
      client.importSkill("https://github.com/acme/team-skills", "workspace"),
    );
    expect(workspace.scope).toBe("workspace");

    const skills = await Effect.runPromise(client.listSkills());
    expect(skills).toHaveLength(2);

    await Effect.runPromise(client.deleteSkill(skill.id));
    expect(await Effect.runPromise(client.listSkills())).toHaveLength(1);

    await expect(Effect.runPromise(client.deleteSkill(skill.id))).rejects.toMatchObject({
      code: "command_failed",
    });
    await Effect.runPromise(client.disconnect());
  });
});

describe("pi sessions", () => {
  it("rejects the pi-session commands at the hub (they are local-daemon-only)", async () => {
    const client = await connect();
    await Effect.runPromise(client.connect());

    await expect(Effect.runPromise(client.listPiSessions())).rejects.toMatchObject({
      code: "command_failed",
      message: "pi sessions are served by the local daemon, not the hub",
    });
    await expect(
      Effect.runPromise(client.importPiSession("/tmp/whatever.jsonl")),
    ).rejects.toMatchObject({
      code: "command_failed",
      message: "pi sessions are served by the local daemon, not the hub",
    });
    await Effect.runPromise(client.disconnect());
  });
});

describe("projects", () => {
  it("rejects the project commands at the hub (they are local-daemon-only)", async () => {
    const client = await connect();
    await Effect.runPromise(client.connect());

    for (const attempt of [
      () => Effect.runPromise(client.listProjects()),
      () => Effect.runPromise(client.addProject("/tmp/work")),
      () => Effect.runPromise(client.removeProject("/tmp/work")),
      () => Effect.runPromise(client.browseProjectDirs("")),
    ]) {
      await expect(attempt()).rejects.toMatchObject({
        code: "command_failed",
        message: "projects are served by the local daemon, not the hub",
      });
    }
    await Effect.runPromise(client.disconnect());
  });
});

describe("fan-out", () => {
  it("delivers every session event to every console", async () => {
    const a = await connect();
    const b = await connect();
    await Effect.runPromise(a.connect());
    await Effect.runPromise(b.connect());
    const id = await newThread(a);

    const seenA: string[] = [];
    const seenB: string[] = [];
    a.on("event", ({ threadId, event }) => {
      if (threadId === id) seenA.push(event.type);
    });
    // b's delivery is async on its own actor; wait for both events.
    const bSettled = new Promise<void>((resolve) => {
      const off = b.on("event", ({ threadId, event }) => {
        if (threadId !== id) return;
        seenB.push(event.type);
        if (seenB.length === 2) {
          off();
          resolve();
        }
      });
    });

    await Effect.runPromise(a.prompt(id, "hello"));
    expect(seenA).toEqual(["entry_appended", "settled"]);
    await bSettled;
    expect(seenB).toEqual(["entry_appended", "settled"]);
    await Effect.runPromise(a.disconnect());
    await Effect.runPromise(b.disconnect());
  });

  it("delivers thread_changed to every console", async () => {
    const a = await connect();
    const b = await connect();
    await Effect.runPromise(a.connect());
    await Effect.runPromise(b.connect());

    const fanned = new Promise<void>((resolve) => {
      const off = b.on("thread_changed", (thread) => {
        if (thread.name === "fanned") {
          off();
          resolve();
        }
      });
    });
    await Effect.runPromise(a.createThread("fanned", {}));
    await fanned;
    await Effect.runPromise(a.disconnect());
    await Effect.runPromise(b.disconnect());
  });
});

describe("request/response correlation", () => {
  it("correlates interleaved responses to their requests", async () => {
    const client = await connect({ requestTimeoutMs: 5_000 });
    await Effect.runPromise(client.connect());
    const a = await newThread(client, "slow thread");
    const b = await newThread(client, "fast thread");

    const seenA: string[] = [];
    const seenB: string[] = [];
    client.on("event", ({ threadId, event }) => {
      if (threadId === a) seenA.push(event.type);
      if (threadId === b) seenB.push(event.type);
    });

    // B's run settles well before A's slow run; both responses must still
    // resolve to their own requests.
    const slow = Effect.runPromise(client.prompt(a, SLOW_PROMPT));
    const quick = Effect.runPromise(client.prompt(b, "hi"));
    await quick;
    await slow;
    expect(seenB).toEqual(["entry_appended", "settled"]);
    expect(seenA).toEqual(["entry_appended", "settled"]);
    await Effect.runPromise(client.disconnect());
  });

  it("correlates concurrent requests to their own responses", async () => {
    const client = await connect();
    await Effect.runPromise(client.connect());

    const names = ["a", "b", "c", "d", "e"];
    const threads = await Promise.all(
      names.map((name) => Effect.runPromise(client.createThread(name, { cwd: "/tmp" }))),
    );
    expect(threads.map((thread) => thread.name).sort()).toEqual([...names].sort());
    await Effect.runPromise(client.disconnect());
  });
});

describe("client behavior", () => {
  it("times out slow commands", async () => {
    const client = await connect({ requestTimeoutMs: 100 });
    await Effect.runPromise(client.connect());
    const id = await newThread(client);
    await expect(Effect.runPromise(client.prompt(id, SLOW_PROMPT))).rejects.toMatchObject({
      code: "timeout",
    });
    await Effect.runPromise(client.disconnect());
  });

  it("fails pending requests when the connection drops", async () => {
    const client = await connect({ requestTimeoutMs: 5_000 });
    await Effect.runPromise(client.connect());
    const id = await newThread(client);

    const pending = Effect.runPromise(client.prompt(id, SLOW_PROMPT));
    await wait(50);
    await Effect.runPromise(hub.dropAll());
    await expect(pending).rejects.toMatchObject({ code: "disconnected" });
    await Effect.runPromise(client.disconnect());
  });

  it("fails pending requests and closes clients when the server closes", async () => {
    const client = await connect({ requestTimeoutMs: 5_000 });
    await Effect.runPromise(client.connect());
    const id = await newThread(client);

    const pending = Effect.runPromise(client.prompt(id, SLOW_PROMPT));
    await wait(50);
    const closed = new Promise<void>((resolve) => client.on("close", () => resolve()));
    await Effect.runPromise(hub.close());
    await expect(pending).rejects.toMatchObject({ code: "disconnected" });
    await closed;
    expect(client.isConnected).toBe(false);
    await Effect.runPromise(client.disconnect());
  });

  it("reconnects with backoff and re-hellos", async () => {
    const client = await connect({ reconnect: true });
    let hellos = 0;
    client.on("hello_ok", () => hellos++);
    const firstHello = new Promise<void>((resolve) => client.on("hello_ok", () => resolve()));
    // The reconnect loop (connect + wait-for-close + retry) runs in the background.
    void Effect.runFork(client.start());
    await firstHello;
    expect(client.isConnected).toBe(true);

    const closed = new Promise<void>((resolve) => client.on("close", () => resolve()));
    await Effect.runPromise(hub.dropAll());
    await closed;
    expect(client.isConnected).toBe(false);

    // The loop re-establishes the connection with backoff.
    for (let i = 0; i < 50 && !client.isConnected; i++) {
      await wait(100);
    }
    expect(client.isConnected).toBe(true);
    expect(hellos).toBeGreaterThanOrEqual(2);
    await Effect.runPromise(client.listThreads());
    await Effect.runPromise(client.disconnect());
  });

  it("surfaces malformed frames as error events", async () => {
    const client = await connect();
    await Effect.runPromise(client.connect());
    const errors: string[] = [];
    client.on("error", ({ message }) => errors.push(message));

    await Effect.runPromise(hub.sendRaw("this is not json\n"));
    await wait();
    expect(errors).toContain("malformed JSON frame from server");
    await Effect.runPromise(client.disconnect());
  });
});

describe("server robustness", () => {
  it("rejects commands before hello", async () => {
    const socket = await rawClient();
    const frames = collectFrames(socket);

    socket.send(serializeFrame({ _tag: "command", id: "x1", command: { _tag: "list_threads" } }));
    await wait();
    expect(frames).toContainEqual({ _tag: "error", message: "hello first" });
    socket.close();
  });

  it("answers malformed frames with an error and keeps the connection", async () => {
    const socket = await rawClient();
    const frames = collectFrames(socket);

    socket.send("this is not json\n");
    await wait();
    expect(frames).toContainEqual({ _tag: "error", message: "malformed JSON frame" });

    // The connection survives: a hello still completes.
    socket.send(
      serializeFrame(Hello.make({ token: TEST_TOKEN, role: "cli", version: WIRE_VERSION })),
    );
    await wait();
    expect(frames.map(tagOf)).toContain("hello_ok");
    socket.close();
  });

  it("answers undecodable frames with an error", async () => {
    const socket = await rawClient();
    const frames = collectFrames(socket);

    socket.send(serializeFrame({ _tag: "bogus" }));
    await wait();
    expect(frames).toContainEqual({ _tag: "error", message: "undecodable message" });
    socket.close();
  });

  it("rejects session commands without a threadId", async () => {
    const socket = await rawClient();
    const frames = collectFrames(socket);

    socket.send(
      serializeFrame(Hello.make({ token: TEST_TOKEN, role: "cli", version: WIRE_VERSION })),
    );
    await wait();
    expect(frames.map(tagOf)).toContain("hello_ok");

    socket.send(serializeFrame({ _tag: "command", id: "x2", command: { _tag: "get_state" } }));
    await wait();
    expect(frames).toContainEqual({
      _tag: "response",
      id: "x2",
      ok: false,
      error: "session command without a threadId",
    });
    socket.close();
  });
});

/** The model-based thread lifecycle test (property-based): arbitrary op
 *  sequences against the real server, checked against an in-memory registry
 *  model. Commands reference threads by a symbolic name drawn from a small
 *  pool, so the known-thread arms (rename/get/delete of a created thread)
 *  are hit as often as the unknown-thread failures. A symbol may name
 *  several threads (duplicate creates): the model stacks them and the
 *  commands act on the newest — the registry truth stays exact.
 *  One fixture serves every run; the model is seeded from the registry's
 *  current state so runs compose.
 */

interface ThreadEntry {
  readonly id: string;
  readonly name: string;
}

/** The in-memory registry the commands are checked against. */
class LifecycleModel {
  /** Symbol → the threads created under it, newest last. */
  readonly stacks = new Map<string, ThreadEntry[]>();
  /** Every live thread by id — the registry truth. */
  readonly all = new Map<string, ThreadEntry>();

  current(symbol: string): ThreadEntry | undefined {
    const stack = this.stacks.get(symbol);
    return stack?.[stack.length - 1];
  }
}

/** An id that can never resolve: real ids are 32-char hex, this is not. */
const bogusId = (symbol: string) => `nope-${symbol}`;

/** The symbol pool: small so later commands hit earlier creates. */
const symbolArb = fc.constantFrom("a", "b", "c", "d", "e", "z", "y", "x");

class CreateThreadCommand implements fc.AsyncCommand<LifecycleModel, WireClientShape> {
  constructor(
    readonly symbol: string,
    readonly name: string,
    readonly cwd: string | null,
  ) {}

  check = () => true;

  async run(model: LifecycleModel, real: WireClientShape) {
    const thread = await Effect.runPromise(
      real.createThread(this.name, this.cwd === null ? {} : { cwd: this.cwd }),
    );
    expect(thread).toMatchObject({
      name: this.name,
      cwd: this.cwd,
      mode: "local",
      state: "idle",
      env: "ready",
    });
    const entry: ThreadEntry = { id: thread.id, name: this.name };
    const stack = model.stacks.get(this.symbol);
    if (stack === undefined) model.stacks.set(this.symbol, [entry]);
    else stack.push(entry);
    model.all.set(entry.id, entry);
  }

  toString() {
    return `create(${JSON.stringify(this.symbol)}, ${JSON.stringify(this.name)})`;
  }
}

class RenameThreadCommand implements fc.AsyncCommand<LifecycleModel, WireClientShape> {
  constructor(
    readonly symbol: string,
    readonly name: string,
  ) {}

  check = () => true;

  async run(model: LifecycleModel, real: WireClientShape) {
    const entry = model.current(this.symbol);
    const id = entry?.id ?? bogusId(this.symbol);
    if (entry === undefined || this.name.trim() === "") {
      // Unknown symbol, or the registry rejects blank renames.
      await expect(Effect.runPromise(real.renameThread(id, this.name))).rejects.toMatchObject({
        code: "command_failed",
      });
      return;
    }
    const renamed = await Effect.runPromise(real.renameThread(entry.id, this.name));
    expect(renamed.name).toBe(this.name.trim());
    entry.name = this.name.trim();
  }

  toString() {
    return `rename(${JSON.stringify(this.symbol)}, ${JSON.stringify(this.name)})`;
  }
}

class GetThreadCommand implements fc.AsyncCommand<LifecycleModel, WireClientShape> {
  constructor(readonly symbol: string) {}

  check = () => true;

  async run(model: LifecycleModel, real: WireClientShape) {
    const entry = model.current(this.symbol);
    if (entry === undefined) {
      await expect(Effect.runPromise(real.getThread(bogusId(this.symbol)))).rejects.toMatchObject({
        code: "command_failed",
      });
      return;
    }
    const got = await Effect.runPromise(real.getThread(entry.id));
    expect(got.id).toBe(entry.id);
    expect(got.name).toBe(entry.name);
  }

  toString() {
    return `get(${JSON.stringify(this.symbol)})`;
  }
}

class DeleteThreadCommand implements fc.AsyncCommand<LifecycleModel, WireClientShape> {
  constructor(readonly symbol: string) {}

  check = () => true;

  async run(model: LifecycleModel, real: WireClientShape) {
    const entry = model.current(this.symbol);
    if (entry === undefined) {
      await expect(
        Effect.runPromise(real.deleteThread(bogusId(this.symbol))),
      ).rejects.toMatchObject({
        code: "command_failed",
      });
      return;
    }
    await Effect.runPromise(real.deleteThread(entry.id));
    model.stacks.get(this.symbol)!.pop();
    model.all.delete(entry.id);
  }

  toString() {
    return `delete(${JSON.stringify(this.symbol)})`;
  }
}

class ListThreadsCommand implements fc.AsyncCommand<LifecycleModel, WireClientShape> {
  check = () => true;

  async run(model: LifecycleModel, real: WireClientShape) {
    const threads = await Effect.runPromise(real.listThreads());
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    expect([...byId.keys()].sort()).toEqual([...model.all.keys()].sort());
    for (const entry of model.all.values()) {
      expect(byId.get(entry.id)?.name).toBe(entry.name);
    }
  }

  toString() {
    return "list()";
  }
}

const lifecycleCommands = () =>
  fc.commands(
    [
      fc
        .record({
          symbol: symbolArb,
          name: fc.string({ maxLength: 12 }),
          cwd: fc.oneof(fc.constant(null), fc.string({ maxLength: 12 })),
        })
        .map(({ symbol, name, cwd }) => new CreateThreadCommand(symbol, name, cwd)),
      fc
        .record({
          symbol: symbolArb,
          // Blank names are common: the registry rejects them (a real
          // contract arm, not a corner case).
          name: fc.oneof(fc.constant(""), fc.constant("   "), fc.string({ maxLength: 12 })),
        })
        .map(({ symbol, name }) => new RenameThreadCommand(symbol, name)),
      fc.record({ symbol: symbolArb }).map(({ symbol }) => new GetThreadCommand(symbol)),
      fc.record({ symbol: symbolArb }).map(({ symbol }) => new DeleteThreadCommand(symbol)),
      fc.constant(new ListThreadsCommand()),
    ],
    { maxCommands: 15 },
  );

describe("thread lifecycle (model-based)", () => {
  it("any op sequence keeps the registry consistent with the model", async () => {
    // One fixture serves every run; the model is re-seeded from the
    // registry's current state so the runs compose.
    const hub = await Effect.runPromise(startHubFixture());
    const client = await Effect.runPromise(
      WireClient.make({ url: hub.url, token: TEST_TOKEN, role: "cli" }),
    );
    await Effect.runPromise(client.connect());
    try {
      await fc.assert(
        fc.asyncProperty(lifecycleCommands(), async (cmds) => {
          await fc.asyncModelRun(async () => {
            const model = new LifecycleModel();
            const threads = await Effect.runPromise(client.listThreads());
            for (const thread of threads) {
              const entry: ThreadEntry = { id: thread.id, name: thread.name };
              model.stacks.set(`seed-${thread.id}`, [entry]);
              model.all.set(entry.id, entry);
            }
            return { model, real: client };
          }, cmds);
        }),
      );
    } finally {
      await Effect.runPromise(client.disconnect());
      await Effect.runPromise(hub.close());
    }
  });
});

/** Prompts containing this text take 300ms on the fixture (timeout tests). */
const SLOW_PROMPT = "slow";
