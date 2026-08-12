/**
 * The wire's integration tests: the whole protocol proven against the mock
 * hub — handshake, version gate, thread lifecycle, session commands, skills,
 * fan-out, timeouts, disconnects, and reconnect. The wire is the integration
 * seam of the whole system (ADR 0004); these tests are its contract.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect } from "effect";

import { WIRE_VERSION, makeWireClient, WireError, type WireClient, type WorkerClientOptions } from "../src/index.ts";
import { MOCK_MODEL, startMockHub, TEST_TOKEN, type MockHub } from "./mock-hub.ts";

const run = <T, E extends WireError>(effect: Effect.Effect<T, E, never>): Promise<T> => Effect.runPromise(effect);

let hub: MockHub;
let seq = 0;

beforeEach(async () => {
  hub = await startMockHub();
  seq = 0;
});

afterEach(async () => {
  await hub.close();
});

const connect = (options?: Partial<WorkerClientOptions>): Promise<WireClient> =>
  run(makeWireClient({ url: hub.url, token: TEST_TOKEN, role: "cli", ...options }));

const newThread = async (client: WireClient, name = `thread ${++seq}`): Promise<string> => {
  const thread = await run(client.createThread(name, { cwd: "/tmp/work" }));
  return thread.id;
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
    await expect(run(client.connect())).rejects.toMatchObject({ code: "handshake", message: "invalid token" });
  });

  it("rejects a version mismatch before anything else", async () => {
    const client = await connect({ version: "0.0.0" });
    await expect(run(client.connect())).rejects.toMatchObject({
      code: "handshake",
      message: `version mismatch: expected ${WIRE_VERSION}`,
    });
  });

  it("fails with refused when nothing is listening", async () => {
    const client = await connect({ url: "ws://127.0.0.1:1" });
    await expect(run(client.connect())).rejects.toMatchObject({ code: "refused" });
  });
});

describe("thread lifecycle", () => {
  it("creates, lists, gets, renames, and deletes threads", async () => {
    const client = await connect();
    await run(client.connect());
    const id = await newThread(client, "alpha");

    const threads = await run(client.listThreads());
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ name: "alpha", cwd: "/tmp/work", state: "idle", env: "ready" });

    const got = await run(client.getThread(id));
    expect(got.id).toBe(id);

    const renamed = await run(client.renameThread(id, "beta"));
    expect(renamed.name).toBe("beta");

    await run(client.deleteThread(id));
    expect(await run(client.listThreads())).toHaveLength(0);
    client.disconnect();
  });

  it("sends thread_changed on every mutation", async () => {
    const client = await connect();
    await run(client.connect());
    const changes: string[] = [];
    client.on("thread_changed", (thread) => changes.push(thread.name));

    await run(client.createThread("first", {}));
    await run(client.createThread("second", {}));
    expect(changes).toEqual(["first", "second"]);
    client.disconnect();
  });

  it("fails command_failed for unknown threads", async () => {
    const client = await connect();
    await run(client.connect());
    await expect(run(client.getThread("nope"))).rejects.toMatchObject({
      code: "command_failed",
      message: "unknown thread: nope",
    });
    client.disconnect();
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
    client.disconnect();
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
    client.disconnect();
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
    await expect(run(client.setModel(id, "mock", "nope"))).rejects.toMatchObject({ code: "command_failed" });

    const stats = await run(client.getSessionStats(id));
    expect(stats).toBeDefined();
    client.disconnect();
  });

  it("rejects a prompt while the agent is working", async () => {
    const client = await connect();
    await run(client.connect());
    const id = await newThread(client);

    // The slow run is still in flight on the mock's side when the second
    // prompt lands; the mock rejects it like the hub does.
    const first = run(client.prompt(id, SLOW_PROMPT));
    await expect(run(client.prompt(id, "second"))).rejects.toMatchObject({
      code: "command_failed",
      message: "agent is already processing",
    });
    await first;
    client.disconnect();
  });

  it("fails session commands for unknown threads", async () => {
    const client = await connect();
    await run(client.connect());
    await expect(run(client.prompt("nope", "hi"))).rejects.toMatchObject({
      code: "command_failed",
      message: "unknown thread: nope",
    });
    client.disconnect();
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
    client.disconnect();
  });
});

describe("skills", () => {
  it("imports, lists, and deletes skills", async () => {
    const client = await connect();
    await run(client.connect());

    const skill = await run(client.importSkill("git@github.com:acme/dotfiles.git"));
    expect(skill).toMatchObject({ name: "dotfiles", scope: "personal", source: "git@github.com:acme/dotfiles.git" });

    const workspace = await run(client.importSkill("https://github.com/acme/team-skills", "workspace"));
    expect(workspace.scope).toBe("workspace");

    const skills = await run(client.listSkills());
    expect(skills).toHaveLength(2);

    await run(client.deleteSkill(skill.id));
    expect(await run(client.listSkills())).toHaveLength(1);

    await expect(run(client.deleteSkill(skill.id))).rejects.toMatchObject({ code: "command_failed" });
    client.disconnect();
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
    a.disconnect();
    b.disconnect();
  });
});

describe("client behavior", () => {
  it("times out slow commands", async () => {
    const client = await connect({ requestTimeoutMs: 100 });
    await run(client.connect());
    const id = await newThread(client);
    await expect(run(client.prompt(id, SLOW_PROMPT))).rejects.toMatchObject({ code: "timeout" });
    client.disconnect();
  });

  it("fails pending requests when the connection drops", async () => {
    const client = await connect({ requestTimeoutMs: 5_000 });
    await run(client.connect());
    const id = await newThread(client);

    const pending = run(client.prompt(id, SLOW_PROMPT));
    await new Promise((resolve) => setTimeout(resolve, 50));
    hub.dropAll();
    await expect(pending).rejects.toMatchObject({ code: "disconnected" });
    client.disconnect();
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
    hub.dropAll();
    await closed;
    expect(client.isConnected).toBe(false);

    // The loop re-establishes the connection with backoff.
    for (let i = 0; i < 50 && !client.isConnected; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(client.isConnected).toBe(true);
    expect(hellos).toBeGreaterThanOrEqual(2);
    await run(client.listThreads());
    client.disconnect();
  });

  it("surfaces malformed frames as error events", async () => {
    const client = await connect();
    await run(client.connect());
    const errors: string[] = [];
    client.on("error", ({ message }) => errors.push(message));

    hub.sendRaw("this is not json\n");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(errors).toContain("malformed JSON frame from server");
    client.disconnect();
  });
});

/** Prompts containing this text take 300ms on the mock (timeout tests). */
const SLOW_PROMPT = "slow";
