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
import { assert, asyncModelRun, asyncProperty } from "fast-check";

import {
  Hello,
  WIRE_VERSION,
  WireClient,
  decodeFrame,
  isSocketMessage,
  parseFrame,
  serializeFrame,
} from "../src/index.ts";
import type { JsonValue, WireClientApi, WorkerClientOptions } from "../src/index.ts";
import { MOCK_MODEL, startHubFixture, TEST_TOKEN } from "./hub-fixture.ts";
import type { HubFixture } from "./hub-fixture.ts";
import { LifecycleModel, lifecycleCommands } from "./thread-model.ts";
import type { ThreadEntry } from "./thread-model.ts";

// Aliased so the TaggedError class declaration below stays a plain call
// (`new` breaks the schema typecheck — `TaggedError` is a function
// returning a class, not a class).
const tagged = Schema.TaggedError;

/** The test file's own failure type (house style: tagged, even in tests). */
class TestError extends tagged<TestError>()("TestError", {
  kind: Schema.Literals(["raw_open_failed"]),
  message: Schema.String,
}) {}

/** Prompts containing this text take 300ms to SETTLE on the fixture (the
 *  run outlives the ack — the run commands' contract); threads named after
 *  it delay their reads (the client-timeout vehicle). */
const SLOW_PROMPT = "slow";

/** The callback payload for events that carry none. */
const NO_PAYLOAD = undefined;

/** The fixture's simulated run latency, in a wait. */
const wait = async (ms = 50) => {
  await Effect.runPromise(Effect.sleep(ms));
};

/**
 * Wait until the predicate holds (or the budget is spent) — the
 * event-delivery assertions poll on observable state instead of wiring
 * promise callbacks.
 */
const until = (predicate: () => boolean, tries = 50, delay = "20 millis") =>
  Effect.gen(function* () {
    for (let i = 0; i < tries; i += 1) {
      if (predicate()) {
        return;
      }
      yield* Effect.sleep(delay);
    }
  });

/** `until` over an async probe (a read that itself rides the wire). */
const untilAsync = (probe: () => Promise<boolean>, tries = 50, delay = "20 millis") =>
  Effect.gen(function* () {
    for (let i = 0; i < tries; i += 1) {
      if (yield* Effect.tryPromise(probe)) {
        return;
      }
      yield* Effect.sleep(delay);
    }
  });

let hub: HubFixture;
let seq = 0;

beforeEach(async () => {
  hub = await Effect.runPromise(startHubFixture());
  seq = 0;
});

afterEach(async () => {
  await Effect.runPromise(hub.close());
});

const connect = async (options?: Partial<WorkerClientOptions>) =>
  await Effect.runPromise(
    WireClient.make({ role: "cli", token: TEST_TOKEN, url: hub.url, ...options }),
  );

const newThread = async (client: WireClientApi, name?: string) => {
  const thread = await Effect.runPromise(
    client.createThread(name ?? `thread ${(seq += 1)}`, { cwd: "/tmp/work" }),
  );
  return thread.id;
};

/** A raw (non-wire-client) WebSocket for the server-robustness tests. */
const rawClient = async () => {
  const socket = new WebSocket(hub.url);
  await Effect.runPromise(
    Effect.callback<undefined, TestError>((resume) => {
      socket.addEventListener(
        "open",
        () => {
          resume(Effect.succeed(NO_PAYLOAD));
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          resume(
            Effect.fail(
              new TestError({ kind: "raw_open_failed", message: "raw client could not open" }),
            ),
          );
        },
        { once: true },
      );
      return Effect.void;
    }),
  );
  return socket;
};

/** Collect the frames a raw socket receives, decoded. */
const collectFrames = (socket: WebSocket) => {
  const frames: (JsonValue | undefined)[] = [];
  socket.addEventListener("message", (message) => {
    const data: unknown = message.data;
    if (isSocketMessage(data)) {
      frames.push(parseFrame(decodeFrame(data)));
    }
  });
  return frames;
};

/** Whether a decoded frame is a tagged object (has a `_tag` discriminant). */
const isTaggedFrame = (
  frame: JsonValue | undefined,
): frame is JsonValue & { readonly _tag: string } =>
  typeof frame === "object" && frame !== null && "_tag" in frame;

/** The `_tag` of a decoded frame, for order-insensitive assertions. */
const tagOf = (frame: JsonValue | undefined) => (isTaggedFrame(frame) ? frame._tag : undefined);

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
      cwd: "/tmp/work",
      env: "ready",
      name: "alpha",
      state: "idle",
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
    client.on("thread_changed", (thread) => {
      changes.push(thread.name);
    });

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
    client.on("event", ({ event }) => {
      events.push(event.type);
    });

    await Effect.runPromise(client.prompt(id, "hello"));
    // The settle lands after the ack (run commands reply at acceptance).
    await Effect.runPromise(until(() => events.length === 2));
    expect(events).toEqual(["entry_appended", "settled"]);
    const { entries, tailSeq, leafId } = await Effect.runPromise(client.getEntries(id));
    expect(entries).toHaveLength(1);
    expect(tailSeq).toBe(1);
    expect(leafId).toBe(entries[0].id);

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
    await Effect.runPromise(
      untilAsync(async () => (await Effect.runPromise(client.getEntries(id))).entries.length >= 1),
    );
    const { entries } = await Effect.runPromise(client.getEntries(id));
    const leaf = await Effect.runPromise(client.branch(id, entries[0].id));
    expect(leaf).toBe(entries[0].id);
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
    await Effect.runPromise(client.compact(id, "keep it short"));
    await Effect.runPromise(client.setAutoCompaction(id, true));
    await Effect.runPromise(client.setSessionName(id, "my session"));
    const named = await Effect.runPromise(client.getState(id));
    expect(named.name).toBe("my session");
    await Effect.runPromise(client.setThinkingLevel(id, "high"));
    const leveled = await Effect.runPromise(client.getState(id));
    expect(leveled.thinkingLevel).toBe("high");
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

    const attempts = [
      async () => await Effect.runPromise(client.listProjects()),
      async () => await Effect.runPromise(client.addProject("/tmp/work")),
      async () => {
        await Effect.runPromise(client.removeProject("/tmp/work"));
      },
      async () => await Effect.runPromise(client.browseProjectDirs("")),
    ];
    await Promise.all(
      attempts.map(async (attempt) => {
        await expect(attempt()).rejects.toMatchObject({
          code: "command_failed",
          message: "projects are served by the local daemon, not the hub",
        });
      }),
    );
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
      if (threadId === id) {
        seenA.push(event.type);
      }
    });
    b.on("event", ({ threadId, event }) => {
      if (threadId !== id) {
        return;
      }
      seenB.push(event.type);
    });

    await Effect.runPromise(a.prompt(id, "hello"));
    // a's delivery is async on its own actor; the settle lands after the ack.
    await Effect.runPromise(until(() => seenA.length === 2));
    expect(seenA).toEqual(["entry_appended", "settled"]);
    // b's delivery is async on its own actor; wait for both events.
    await Effect.runPromise(until(() => seenB.length === 2));
    expect(seenB).toEqual(["entry_appended", "settled"]);
    await Effect.runPromise(a.disconnect());
    await Effect.runPromise(b.disconnect());
  });

  it("delivers thread_changed to every console", async () => {
    const a = await connect();
    const b = await connect();
    await Effect.runPromise(a.connect());
    await Effect.runPromise(b.connect());

    let fannedSeen = false;
    b.on("thread_changed", (thread) => {
      if (thread.name === "fanned") {
        fannedSeen = true;
      }
    });
    await Effect.runPromise(a.createThread("fanned", {}));
    await Effect.runPromise(until(() => fannedSeen));
    await Effect.runPromise(a.disconnect());
    await Effect.runPromise(b.disconnect());
  });
});

describe("request/response correlation", () => {
  it("correlates interleaved responses to their requests", async () => {
    const client = await connect({ requestTimeoutMs: 5000 });
    await Effect.runPromise(client.connect());
    const a = await newThread(client, "slow thread");
    const b = await newThread(client, "fast thread");

    const seenA: string[] = [];
    const seenB: string[] = [];
    client.on("event", ({ threadId, event }) => {
      if (threadId === a) {
        seenA.push(event.type);
      }
      if (threadId === b) {
        seenB.push(event.type);
      }
    });

    // B's run settles well before A's slow run; each response and each
    // event stream must land on its own thread and request.
    await Effect.runPromise(client.prompt(a, SLOW_PROMPT));
    await Effect.runPromise(client.prompt(b, "hi"));
    await Effect.runPromise(until(() => seenA.length === 2 && seenB.length === 2));
    expect(seenB).toEqual(["entry_appended", "settled"]);
    expect(seenA).toEqual(["entry_appended", "settled"]);
    await Effect.runPromise(client.disconnect());
  });

  it("correlates concurrent requests to their own responses", async () => {
    const client = await connect();
    await Effect.runPromise(client.connect());

    const names = ["a", "b", "c", "d", "e"];
    const threads = await Promise.all(
      names.map(
        async (name) => await Effect.runPromise(client.createThread(name, { cwd: "/tmp" })),
      ),
    );
    expect(new Set(threads.map((thread) => thread.name))).toEqual(new Set(names));
    await Effect.runPromise(client.disconnect());
  });
});

describe("client behavior", () => {
  it("times out slow commands", async () => {
    const client = await connect({ requestTimeoutMs: 100 });
    await Effect.runPromise(client.connect());
    // The slow marker rides the thread NAME: reads for that thread are
    // delayed by the fixture (run commands ack too fast to time out).
    const id = await newThread(client, "slow thread");
    await expect(Effect.runPromise(client.getState(id))).rejects.toMatchObject({
      code: "timeout",
    });
    await Effect.runPromise(client.disconnect());
  });

  it("fails pending requests when the connection drops", async () => {
    const client = await connect({ requestTimeoutMs: 5000 });
    await Effect.runPromise(client.connect());
    const id = await newThread(client, "slow drop");

    const pending = Effect.runPromise(client.getState(id));
    await wait(50);
    await Effect.runPromise(hub.dropAll());
    await expect(pending).rejects.toMatchObject({ code: "disconnected" });
    await Effect.runPromise(client.disconnect());
  });

  it("fails pending requests and closes clients when the server closes", async () => {
    const client = await connect({ requestTimeoutMs: 5000 });
    await Effect.runPromise(client.connect());
    const id = await newThread(client, "slow close");

    const pending = Effect.runPromise(client.getState(id));
    await wait(50);
    await Effect.runPromise(hub.close());
    await expect(pending).rejects.toMatchObject({ code: "disconnected" });
    await Effect.runPromise(until(() => !client.isConnected));
    expect(client.isConnected).toBe(false);
    await Effect.runPromise(client.disconnect());
  });

  it("reconnects with backoff and re-hellos", async () => {
    const client = await connect({ reconnect: true });
    let hellos = 0;
    client.on("hello_ok", () => {
      hellos += 1;
    });
    // The reconnect loop (connect + wait-for-close + retry) runs in the background.
    void Effect.runFork(client.start());
    await Effect.runPromise(until(() => client.isConnected));
    expect(client.isConnected).toBe(true);

    await Effect.runPromise(hub.dropAll());
    await Effect.runPromise(until(() => !client.isConnected));
    expect(client.isConnected).toBe(false);

    // The loop re-establishes the connection with backoff.
    await Effect.runPromise(until(() => client.isConnected, 50, "100 millis"));
    expect(client.isConnected).toBe(true);
    expect(hellos).toBeGreaterThanOrEqual(2);
    await Effect.runPromise(client.listThreads());
    await Effect.runPromise(client.disconnect());
  });

  it("surfaces malformed frames as error events", async () => {
    const client = await connect();
    await Effect.runPromise(client.connect());
    const errors: string[] = [];
    client.on("error", ({ message }) => {
      errors.push(message);
    });

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

    socket.send(serializeFrame({ _tag: "command", command: { _tag: "list_threads" }, id: "x1" }));
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
      serializeFrame(Hello.make({ role: "cli", token: TEST_TOKEN, version: WIRE_VERSION })),
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

  it("answers pings with pongs (the keepalive)", async () => {
    const socket = await rawClient();
    const frames = collectFrames(socket);

    socket.send(serializeFrame({ _tag: "ping" }));
    await wait();
    expect(frames).toContainEqual({ _tag: "pong" });
    socket.close();
  });

  it("rejects session commands without a threadId", async () => {
    const socket = await rawClient();
    const frames = collectFrames(socket);

    socket.send(
      serializeFrame(Hello.make({ role: "cli", token: TEST_TOKEN, version: WIRE_VERSION })),
    );
    await wait();
    expect(frames.map(tagOf)).toContain("hello_ok");

    socket.send(serializeFrame({ _tag: "command", command: { _tag: "get_state" }, id: "x2" }));
    await wait();
    expect(frames).toContainEqual({
      _tag: "response",
      error: "session command without a threadId",
      id: "x2",
      ok: false,
    });
    socket.close();
  });
});

describe("thread lifecycle (model-based)", () => {
  it("any op sequence keeps the registry consistent with the model", async () => {
    // One fixture serves every run; the model is re-seeded from the
    // registry's current state so the runs compose.
    const fixture = await Effect.runPromise(startHubFixture());
    const client = await Effect.runPromise(
      WireClient.make({ role: "cli", token: TEST_TOKEN, url: fixture.url }),
    );
    await Effect.runPromise(client.connect());
    try {
      await assert(
        asyncProperty(lifecycleCommands(), async (cmds) => {
          await asyncModelRun(async () => {
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
      await Effect.runPromise(fixture.close());
    }
  });
});
