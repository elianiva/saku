/**
 * Hub core tests: the control plane without sockets — registry-backed
 * thread lifecycle, the worker seam (scripted), the env gate (lazy
 * provisioning, sandbox failure → `error`), worker reports (state,
 * sessionId, auto-title vs. user rename), read-only bypass, and skills.
 */

import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";

import { KvStore } from "@saku/store";
import { GetEntriesResponse } from "@saku/wire";

import { HubError } from "../src/hub-error.ts";

import {
  Hub,
  HubRegistry,
  SkillsStore,
  type EnvProvisioner,
  type HubEvent,
  type HubShape,
} from "../src/index.ts";
import { scriptedProvisioner, scriptedWorker, type ScriptedWorker } from "./mock-worker.ts";

const run = <A, E extends Error>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect);

/** A polling assertion that gave up (the async fork hadn't landed in time). */
class TestError extends Schema.TaggedError<TestError>()("TestError", {
  message: Schema.String,
}) {}

/** Poll until the condition holds (worker-event forks land asynchronously). */
const waitFor = async (fn: () => boolean | Promise<boolean>, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new TestError({ message: "condition not met" });
};

interface World {
  readonly hub: HubShape;
  readonly worker: ScriptedWorker;
  /** Every thread_changed / session event the hub pushed. */
  readonly events: HubEvent[];
}

const makeWorld = (provisioner: EnvProvisioner = scriptedProvisioner()) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* HubRegistry.make().pipe(Effect.provide(KvStore.memory()));
      const skills = yield* SkillsStore.make().pipe(Effect.provide(KvStore.memory()));
      const worker = scriptedWorker();
      const hub = yield* Hub.make({ registry, skills, workerRef: worker.ref, provisioner });
      worker.attach(hub.events);
      const events: HubEvent[] = [];
      hub.subscribe((event) => events.push(event));
      return { hub, worker, events };
    }),
  );

/** The thread_changed events' thread list, in order. */
const changedIds = (events: HubEvent[]) =>
  events.filter((event) => event._tag === "thread_changed").map((event) => event.thread.id);

/** A scripted run: prompt settles, emits entry + settled, reports state. */
const scriptPrompt = (world: World, text: string, tailSeq = 1) => {
  world.worker.onCommand((threadId, command) => {
    if (command._tag !== "prompt") {
      return Effect.fail(
        new HubError({ kind: "command", message: `unscripted command: ${command._tag}` }),
      );
    }
    world.worker.report(threadId, { state: "working" });
    world.worker.emit(
      threadId,
      { type: "entry_appended", entry: { id: "e1", type: "user_message", text } } as never,
      tailSeq,
    );
    world.worker.emit(threadId, { type: "settled" }, tailSeq);
    world.worker.report(threadId, { state: "idle" });
    return Effect.succeed({ payload: { _tag: "prompt" }, tailSeq });
  });
};

describe("Hub.make — threads", () => {
  it("creates a thread, creates its worker, and broadcasts", async () => {
    const world = await makeWorld();
    const thread = await run(world.hub.createThread({ name: "hello world" }));
    expect(world.worker.created).toEqual([thread.id]);
    expect(thread).toMatchObject({
      name: "hello world",
      cwd: null,
      mode: "local",
      state: "idle",
      env: "ready",
    });
    expect(changedIds(world.events)).toEqual([thread.id]);
  });

  it("rolls back when the worker cannot be created", async () => {
    const world = await makeWorld();
    world.worker.failCreateWith(new HubError({ kind: "worker", message: "no worker namespace" }));
    await expect(run(world.hub.createThread({ name: "doomed" }))).rejects.toMatchObject({
      message: "failed to create worker: no worker namespace",
    });
    expect((await run(world.hub.listThreads())).length).toBe(0);
    expect(changedIds(world.events)).toEqual([]);
  });

  it("lists, gets (by id and prefix), renames, and deletes", async () => {
    const world = await makeWorld();
    const a = await run(world.hub.createThread({ name: "alpha" }));
    const b = await run(world.hub.createThread({ name: "beta" }));

    expect((await run(world.hub.listThreads())).map((t) => t.id)).toEqual([a.id, b.id]);
    expect((await run(world.hub.getThread(a.id.slice(0, 8)))).id).toBe(a.id);
    await expect(run(world.hub.getThread("nope"))).rejects.toMatchObject({
      message: 'no thread matches "nope"',
    });

    const renamed = await run(world.hub.renameThread(b.id, "bravo"));
    expect(renamed.name).toBe("bravo");
    expect((await run(world.hub.getThread(b.id))).name).toBe("bravo");
    await expect(run(world.hub.renameThread(b.id, "   "))).rejects.toMatchObject({
      message: "name must not be empty",
    });

    const removed = await run(world.hub.deleteThread(a.id));
    expect(removed.id).toBe(a.id);
    expect(world.worker.deleted).toEqual([a.id]);
    expect((await run(world.hub.listThreads())).map((t) => t.id)).toEqual([b.id]);
  });

  it("creates sandbox threads with a stopped env", async () => {
    const world = await makeWorld();
    const thread = await run(world.hub.createThread({ name: "boxed", mode: "sandbox" }));
    expect(thread.env).toBe("stopped");
  });
});

describe("Hub.make — sessions and the env gate", () => {
  it("forwards session commands to the worker and caches tailSeq", async () => {
    const world = await makeWorld();
    const thread = await run(world.hub.createThread({ name: "t" }));
    world.worker.onCommand((threadId, command) => {
      expect(command._tag).toBe("get_entries");
      return Effect.succeed({
        payload: GetEntriesResponse.make({ entries: [], tailSeq: 9, leafId: null }),
        tailSeq: 9,
      });
    });
    const payload = await run(
      world.hub.runSessionCommand(thread.id, { _tag: "get_entries", sinceSeq: 0 }),
    );
    expect(payload._tag).toBe("get_entries");
    expect(world.worker.commands.map((c) => c.threadId)).toEqual([thread.id]);
    const info = await run(world.hub.getThread(thread.id));
    expect(info.tailSeq).toBe(9);
  });

  it("runs a prompt: env gate, working → idle reports, session events", async () => {
    const world = await makeWorld();
    const thread = await run(world.hub.createThread({ name: "t" }));
    scriptPrompt(world, "hello", 4);
    await run(world.hub.runSessionCommand(thread.id, { _tag: "prompt", text: "hello" }));

    // The worker's event/report forks land asynchronously; wait for the run's
    // reports (working → idle) and the tailSeq it carried.
    await waitFor(() => {
      const changed = world.events
        .filter((event) => event._tag === "thread_changed")
        .map((event) => event.thread);
      return changed.at(-1)?.state === "idle" && changed.at(-1)?.tailSeq === 4;
    });
    const sessionEvents = world.events.filter((event) => event._tag === "session_event");
    expect(sessionEvents.map((event) => event.event)).toEqual([
      { type: "entry_appended", entry: { id: "e1", type: "user_message", text: "hello" } },
      { type: "settled" },
    ]);
    // The reports broadcast working and idle; tailSeq shows the run's sequence.
    const changed = world.events
      .filter((event) => event._tag === "thread_changed")
      .map((event) => event.thread);
    expect(changed.map((t) => t.state)).toEqual(["idle", "working", "idle"]);
    expect(changed.at(-1)?.tailSeq).toBe(4);
  });

  it("read-only commands bypass the env gate (browsing a stopped Box is free)", async () => {
    const world = await makeWorld();
    const thread = await run(world.hub.createThread({ name: "boxed", mode: "sandbox" }));
    const payload = await run(world.hub.runSessionCommand(thread.id, { _tag: "get_state" }));
    expect(payload._tag).toBe("get_state");
    // No env flip happened: the sandbox thread is still stopped.
    expect((await run(world.hub.getThread(thread.id))).env).toBe("stopped");
  });

  it("mutating a sandbox thread fails provisioning and flips the env to error", async () => {
    const world = await makeWorld(scriptedProvisioner({ fail: true }));
    const thread = await run(world.hub.createThread({ name: "boxed", mode: "sandbox" }));
    await expect(
      run(world.hub.runSessionCommand(thread.id, { _tag: "prompt", text: "hi" })),
    ).rejects.toMatchObject({
      message: "sandbox provisioning failed (scripted)",
    });
    expect(world.worker.commands).toHaveLength(0); // never reached the worker
    const info = await run(world.hub.getThread(thread.id));
    expect(info.env).toBe("error");
    expect(changedIds(world.events).length).toBe(2); // created, then error
    const last = world.events.filter((event) => event._tag === "thread_changed").at(-1);
    expect(last?.thread.env).toBe("error");
  });

  it("provisions a stopped env on first touch when the provisioner succeeds", async () => {
    const provisioner = scriptedProvisioner();
    const world = await makeWorld(provisioner);
    const thread = await run(world.hub.createThread({ name: "boxed", mode: "sandbox" }));
    expect(thread.env).toBe("stopped");
    scriptPrompt(world, "hi");
    await run(world.hub.runSessionCommand(thread.id, { _tag: "prompt", text: "hi" }));
    await waitFor(() => {
      const changed = world.events
        .filter((event) => event._tag === "thread_changed")
        .map((event) => event.thread);
      return changed.at(-1)?.state === "idle";
    });
    // The env axis: stopped (created) → ready (gate) → ready through the run.
    const envs = world.events
      .filter((event) => event._tag === "thread_changed")
      .map((event) => event.thread.env);
    expect(envs).toEqual(["stopped", "ready", "ready", "ready"]);
    const states = world.events
      .filter((event) => event._tag === "thread_changed")
      .map((event) => event.thread.state);
    expect(states).toEqual(["idle", "idle", "working", "idle"]);
  });
});

describe("Hub.make — worker reports", () => {
  it("applies auto-title while the name is auto-generated", async () => {
    const world = await makeWorld();
    const thread = await run(world.hub.createThread({ name: "quick start", autoName: true }));
    world.worker.report(thread.id, { name: "A great title — quick start" });
    await waitFor(
      async () =>
        (await run(world.hub.getThread(thread.id))).name === "A great title — quick start",
    );
  });

  it("ignores auto-title after a user rename (the rename wins forever)", async () => {
    const world = await makeWorld();
    const thread = await run(world.hub.createThread({ name: "quick start", autoName: true }));
    await run(world.hub.renameThread(thread.id, "user chosen"));
    world.worker.report(thread.id, { name: "A late auto-title" });
    expect((await run(world.hub.getThread(thread.id))).name).toBe("user chosen");
  });

  it("caches sessionId and broadcasts state changes", async () => {
    const world = await makeWorld();
    const thread = await run(world.hub.createThread({ name: "t" }));
    world.worker.report(thread.id, { sessionId: "sess-1" });
    world.worker.report(thread.id, { state: "working" });
    await waitFor(async () => {
      const info = await run(world.hub.getThread(thread.id));
      return info.sessionId === "sess-1" && info.state === "working";
    });
    const info = await run(world.hub.getThread(thread.id));
    expect(info).toMatchObject({ sessionId: "sess-1", state: "working" });
    // Both reports broadcast (sessionId and state each change the wire view);
    // the forks are independent, so only the endpoints are ordered.
    await waitFor(
      () => world.events.filter((event) => event._tag === "thread_changed").length === 3,
    );
    const states = world.events
      .filter((event) => event._tag === "thread_changed")
      .map((event) => event.thread.state);
    expect(states).toHaveLength(3);
    expect(states[0]).toBe("idle");
    expect(states.at(-1)).toBe("working");
  });
});

describe("Hub.make — skills", () => {
  it("imports, lists, and deletes skills", async () => {
    const world = await makeWorld();
    const skill = await run(world.hub.importSkill("https://github.com/foo/bar-baz.git"));
    expect(skill).toMatchObject({
      name: "bar-baz",
      scope: "personal",
      source: "https://github.com/foo/bar-baz.git",
      version: null,
    });
    const workspace = await run(
      world.hub.importSkill("https://github.com/foo/team.git", "workspace"),
    );
    expect(workspace.scope).toBe("workspace");
    const skills = await run(world.hub.listSkills());
    expect(skills.map((s) => s.name)).toEqual(["bar-baz", "team"]);
    await run(world.hub.deleteSkill(skill.id));
    expect((await run(world.hub.listSkills())).map((s) => s.name)).toEqual(["team"]);
    await expect(run(world.hub.deleteSkill(skill.id))).rejects.toMatchObject({
      message: `unknown skill: ${skill.id}`,
    });
  });
});

describe("Hub.make — resolution", () => {
  it("resolves session commands by name and unambiguous prefix", async () => {
    const world = await makeWorld();
    const a = await run(world.hub.createThread({ name: "alpha" }));
    const b = await run(world.hub.createThread({ name: "beta" }));
    world.worker.onCommand((_threadId, _command) =>
      Effect.succeed({
        payload: GetEntriesResponse.make({ entries: [], tailSeq: 0, leafId: null }),
        tailSeq: 0,
      }),
    );
    await run(world.hub.runSessionCommand("alpha", { _tag: "get_entries" }));
    await run(world.hub.runSessionCommand(b.id.slice(0, 8), { _tag: "get_entries" }));
    expect(world.worker.commands.map((c) => c.threadId)).toEqual([a.id, b.id]);
    await expect(
      run(world.hub.runSessionCommand("al", { _tag: "get_entries" })),
    ).rejects.toMatchObject({
      message: /ambiguous/,
    });
  });
});
