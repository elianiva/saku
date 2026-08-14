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

const run = <T, E extends WireError>(effect: Effect.Effect<T, E, never>) =>
  Effect.runPromise(effect);

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
  run(WireClient.make({ url: hub.url, token: TEST_TOKEN, role: "cli", ...options }));

const newThread = async (client: WireClientShape, name = `thread ${++seq}`) => {
  const thread = await run(client.createThread(name, { cwd: "/tmp/work" }));
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
    const hello = await run(client.connect());
    expect(hello.version).toBe(WIRE_VERSION);
    expect(hello.pid).toBeTypeOf("number");
    await run(client.disconnect());
  });

  it("rejects a bad token", async () => {
    const client = await connect({ token: "wrong" });
    await expect(run(client.connect())).rejects.toMatchObject({
      code: "handshake",
      message: "invalid token",
    });
    await run(client.disconnect());
  });

  it("rejects a version mismatch before anything else", async () => {
    const client = await connect({ version: "0.0.0" });
    await expect(run(client.connect())).rejects.toMatchObject({
      code: "handshake",
      message: `version mismatch: expected ${WIRE_VERSION}`,
    });
    await run(client.disconnect());
  });

  it("fails with refused when nothing is listening", async () => {
    const client = await connect({ url: "ws://127.0.0.1:1" });
    await expect(run(client.connect())).rejects.toMatchObject({ code: "refused" });
    await run(client.disconnect());
  });
});

describe("thread lifecycle", () => {
  it("creates, lists, gets, renames, and deletes threads", async () => {
    const client = await connect();
    await run(client.connect());
    const id = await newThread(client, "alpha");

    const threads = await run(client.listThreads());
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      name: "alpha",
      cwd: "/tmp/work",
      state: "idle",
      env: "ready",
    });

    const got = await run(client.getThread(id));
    expect(got.id).toBe(id);

    const renamed = await run(client.renameThread(id, "beta"));
    expect(renamed.name).toBe("beta");

    await run(client.deleteThread(id));
    expect(await run(client.listThreads())).toHaveLength(0);
    await run(client.disconnect());
  });

  it("sends thread_changed on every mutation", async () => {
    const client = await connect();
    await run(client.connect());
    const changes: string[] = [];
    client.on("thread_changed", (thread) => changes.push(thread.name));

    await run(client.createThread("first", {}));
    await run(client.createThread("second", {}));
    expect(changes).toEqual(["first", "second"]);
    await run(client.disconnect());
  });

  it("fails command_failed for unknown threads", async () => {
    const client = await connect();
    await run(client.connect());
    await expect(run(client.getThread("nope"))).rejects.toMatchObject({
      code: "command_failed",
      message: "unknown thread: nope",
    });
    await run(client.disconnect());
  });
});

describe("session commands", () => {
  it("prompt appends entries, settles, and is readable back", async () => {
    const client = await connect();
    await run(client.connect());
    const id = await newThread(client);

    const events: string[] = [];
    client.on("event", ({ event }) => events.push(event.type));

    await run(client.prompt(id, "hello"));
    expect(events).toEqual(["entry_appended", "settled"]);

    const { entries, tailSeq, leafId } = await run(client.getEntries(id));
    expect(entries).toHaveLength(1);
    expect(tailSeq).toBe(1);
    expect(leafId).toBe(entries[0]!.id);

    const state = await run(client.getState(id));
    expect(state.state).toBe("idle");
    expect(state.sessionId).toBe(id);
    await run(client.disconnect());
  });

  it("supports reads without ever creating a session", async () => {
    const client = await connect();
    await run(client.connect());
    const id = await newThread(client);

    const { entries, tailSeq } = await run(client.getEntries(id));
    expect(entries).toHaveLength(0);
    expect(tailSeq).toBe(0);
    const state = await run(client.getState(id));
    expect(state.sessionId).toBeNull();
    await run(client.disconnect());
  });

  it("serves models, thinking levels, and session stats", async () => {
    const client = await connect();
    await run(client.connect());
    const id = await newThread(client);

    const models = await run(client.getAvailableModels(id));
    expect(models).toEqual([MOCK_MODEL]);
    const levels = await run(client.getAvailableThinkingLevels(id));
    expect(levels).toContain("high");

    await run(client.setModel(id, "mock", "m1"));
    await run(client.setThinkingLevel(id, "high"));
    await expect(run(client.setModel(id, "mock", "nope"))).rejects.toMatchObject({
      code: "command_failed",
    });

    const stats = await run(client.getSessionStats(id));
    expect(stats).toBeDefined();
    await run(client.disconnect());
  });

  it("rejects a prompt while the agent is working", async () => {
    const client = await connect();
    await run(client.connect());
    const id = await newThread(client);

    // The slow run is still in flight on the fixture's side when the second
    // prompt lands; the fixture rejects it like the hub does.
    const first = run(client.prompt(id, SLOW_PROMPT));
    await expect(run(client.prompt(id, "second"))).rejects.toMatchObject({
      code: "command_failed",
      message: "agent is already processing",
    });
    await first;
    await run(client.disconnect());
  });

  it("fails session commands for unknown threads", async () => {
    const client = await connect();
    await run(client.connect());
    await expect(run(client.prompt("nope", "hi"))).rejects.toMatchObject({
      code: "command_failed",
      message: "unknown thread: nope",
    });
    await run(client.disconnect());
  });

  it("branches to a past entry", async () => {
    const client = await connect();
    await run(client.connect());
    const id = await newThread(client);
    await run(client.prompt(id, "first"));
    const { entries } = await run(client.getEntries(id));
    const leaf = await run(client.branch(id, entries[0]!.id));
    expect(leaf).toBe(entries[0]!.id);
    await expect(run(client.branch(id, "e99"))).rejects.toMatchObject({ code: "command_failed" });
    await run(client.disconnect());
  });

  it("round-trips every session command and dispatches each to its handler", async () => {
    const client = await connect();
    await run(client.connect());
    const id = await newThread(client);

    await run(client.steer(id, "stay on task"));
    await run(client.followUp(id, "and then?"));
    await run(client.setSteeringMode(id, "one-at-a-time"));
    await run(client.setFollowUpMode(id, "one-at-a-time"));
    const compact = await run(client.compact(id, "keep it short"));
    expect(compact.summary).toBe("mock");
    expect(compact.tokensBefore).toBe(0);
    await run(client.setAutoCompaction(id, true));
    await run(client.setSessionName(id, "my session"));
    expect((await run(client.getState(id))).name).toBe("my session");
    await run(client.setThinkingLevel(id, "high"));
    expect((await run(client.getState(id))).thinkingLevel).toBe("high");
    await run(client.abort(id));

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
    await run(client.disconnect());
  });
});

describe("skills", () => {
  it("imports, lists, and deletes skills", async () => {
    const client = await connect();
    await run(client.connect());

    const skill = await run(client.importSkill("git@github.com:acme/dotfiles.git"));
    expect(skill).toMatchObject({
      name: "dotfiles",
      scope: "personal",
      source: "git@github.com:acme/dotfiles.git",
    });

    const workspace = await run(
      client.importSkill("https://github.com/acme/team-skills", "workspace"),
    );
    expect(workspace.scope).toBe("workspace");

    const skills = await run(client.listSkills());
    expect(skills).toHaveLength(2);

    await run(client.deleteSkill(skill.id));
    expect(await run(client.listSkills())).toHaveLength(1);

    await expect(run(client.deleteSkill(skill.id))).rejects.toMatchObject({
      code: "command_failed",
    });
    await run(client.disconnect());
  });
});

describe("pi sessions", () => {
  it("rejects the pi-session commands at the hub (they are local-daemon-only)", async () => {
    const client = await connect();
    await run(client.connect());

    await expect(run(client.listPiSessions())).rejects.toMatchObject({
      code: "command_failed",
      message: "pi sessions are served by the local daemon, not the hub",
    });
    await expect(run(client.importPiSession("/tmp/whatever.jsonl"))).rejects.toMatchObject({
      code: "command_failed",
      message: "pi sessions are served by the local daemon, not the hub",
    });
    await run(client.disconnect());
  });
});

describe("fan-out", () => {
  it("delivers every session event to every console", async () => {
    const a = await connect();
    const b = await connect();
    await run(a.connect());
    await run(b.connect());
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

    await run(a.prompt(id, "hello"));
    expect(seenA).toEqual(["entry_appended", "settled"]);
    await bSettled;
    expect(seenB).toEqual(["entry_appended", "settled"]);
    await run(a.disconnect());
    await run(b.disconnect());
  });

  it("delivers thread_changed to every console", async () => {
    const a = await connect();
    const b = await connect();
    await run(a.connect());
    await run(b.connect());

    const fanned = new Promise<void>((resolve) => {
      const off = b.on("thread_changed", (thread) => {
        if (thread.name === "fanned") {
          off();
          resolve();
        }
      });
    });
    await run(a.createThread("fanned", {}));
    await fanned;
    await run(a.disconnect());
    await run(b.disconnect());
  });
});

describe("request/response correlation", () => {
  it("correlates interleaved responses to their requests", async () => {
    const client = await connect({ requestTimeoutMs: 5_000 });
    await run(client.connect());
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
    const slow = run(client.prompt(a, SLOW_PROMPT));
    const quick = run(client.prompt(b, "hi"));
    await quick;
    await slow;
    expect(seenB).toEqual(["entry_appended", "settled"]);
    expect(seenA).toEqual(["entry_appended", "settled"]);
    await run(client.disconnect());
  });

  it("correlates concurrent requests to their own responses", async () => {
    const client = await connect();
    await run(client.connect());

    const names = ["a", "b", "c", "d", "e"];
    const threads = await Promise.all(
      names.map((name) => run(client.createThread(name, { cwd: "/tmp" }))),
    );
    expect(threads.map((thread) => thread.name).sort()).toEqual([...names].sort());
    await run(client.disconnect());
  });
});

describe("client behavior", () => {
  it("times out slow commands", async () => {
    const client = await connect({ requestTimeoutMs: 100 });
    await run(client.connect());
    const id = await newThread(client);
    await expect(run(client.prompt(id, SLOW_PROMPT))).rejects.toMatchObject({ code: "timeout" });
    await run(client.disconnect());
  });

  it("fails pending requests when the connection drops", async () => {
    const client = await connect({ requestTimeoutMs: 5_000 });
    await run(client.connect());
    const id = await newThread(client);

    const pending = run(client.prompt(id, SLOW_PROMPT));
    await wait(50);
    await run(hub.dropAll());
    await expect(pending).rejects.toMatchObject({ code: "disconnected" });
    await run(client.disconnect());
  });

  it("fails pending requests and closes clients when the server closes", async () => {
    const client = await connect({ requestTimeoutMs: 5_000 });
    await run(client.connect());
    const id = await newThread(client);

    const pending = run(client.prompt(id, SLOW_PROMPT));
    await wait(50);
    const closed = new Promise<void>((resolve) => client.on("close", () => resolve()));
    await run(hub.close());
    await expect(pending).rejects.toMatchObject({ code: "disconnected" });
    await closed;
    expect(client.isConnected).toBe(false);
    await run(client.disconnect());
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
    await run(hub.dropAll());
    await closed;
    expect(client.isConnected).toBe(false);

    // The loop re-establishes the connection with backoff.
    for (let i = 0; i < 50 && !client.isConnected; i++) {
      await wait(100);
    }
    expect(client.isConnected).toBe(true);
    expect(hellos).toBeGreaterThanOrEqual(2);
    await run(client.listThreads());
    await run(client.disconnect());
  });

  it("surfaces malformed frames as error events", async () => {
    const client = await connect();
    await run(client.connect());
    const errors: string[] = [];
    client.on("error", ({ message }) => errors.push(message));

    await run(hub.sendRaw("this is not json\n"));
    await wait();
    expect(errors).toContain("malformed JSON frame from server");
    await run(client.disconnect());
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

/** Prompts containing this text take 300ms on the fixture (timeout tests). */
const SLOW_PROMPT = "slow";
