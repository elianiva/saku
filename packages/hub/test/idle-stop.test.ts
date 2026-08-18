/**
 * Idle-stop (ADR 0003): a sandbox env that has been idle is stopped by
 * the hub (snapshot, billing paused) and resumed on the next prompt;
 * local envs never stop. The timer is armed when a ready sandbox thread
 * is idle, reset by any activity (commands, events, worker reports), and
 * fires → the provisioner's release + env axis `stopped`, broadcast.
 *
 * Two suites: the hub-level transitions (below) over real timers with a
 * short window (60 ms), and the policy's contract directly (the second
 * describe) — `IdleStop.make` driven with scripted fakes and a fake
 * controller, covering the arm/disarm/reset/fire transitions without
 * clock flakiness.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { Effect, Option, Schema } from "effect";

import type { EnvHandle } from "@saku/env";
import type { ThreadEnvState, ThreadInfo, ThreadMode, ThreadState } from "@saku/wire";

import { HubError } from "../src/hub-error.ts";

import { Hub, HubRegistry, IdleStop, SkillsStore } from "../src/index.ts";
import type { HubEvent, HubRecord, HubApi, IdleStopApi, IdleStopController } from "../src/index.ts";
import { scriptedProvisioner, scriptedWorker } from "./mock-worker.ts";
import { KvStore } from "@saku/store";

const IDLE_MS = 60;

/** A polling assertion that gave up (the async fork hadn't landed in time). */
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

interface World {
  readonly hub: HubApi;
  readonly worker: ReturnType<typeof scriptedWorker>;
  readonly provisioner: ReturnType<typeof scriptedProvisioner>;
  readonly events: HubEvent[];
}

const makeWorld = async () => {
  const world = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* HubRegistry.make().pipe(Effect.provide(KvStore.memory()));
      const skills = yield* SkillsStore.make().pipe(Effect.provide(KvStore.memory()));
      const worker = scriptedWorker();
      const provisioner = scriptedProvisioner();
      const hub = yield* Hub.make({
        idleStopMs: IDLE_MS,
        provisioner,
        registry,
        skills,
        workerRef: worker.ref,
      });
      worker.attach(hub.events);
      const events: HubEvent[] = [];
      hub.subscribe((event) => {
        events.push(event);
      });
      return { events, hub, provisioner, worker };
    }),
  );
  return world;
};

/** Script a prompt that reports working → idle (the mock worker's habit). */
const scriptPrompt = (world: World, _text: string) => {
  world.worker.onCommand((threadId, command) => {
    if (command._tag !== "prompt") {
      return Effect.fail(
        new HubError({ kind: "command", message: `unscripted command: ${command._tag}` }),
      );
    }
    world.worker.report(threadId, { state: "working" });
    world.worker.emit(threadId, { type: "settled" }, 1);
    world.worker.report(threadId, { state: "idle" });
    return Effect.succeed({ payload: { _tag: "prompt" }, tailSeq: 1 });
  });
};

describe("idle-stop", () => {
  it("stops a sandbox env after the thread has been idle", async () => {
    const world = await makeWorld();
    scriptPrompt(world, "hi");
    const thread = await Effect.runPromise(
      world.hub.createThread({ mode: "sandbox", name: "boxed" }),
    );
    await Effect.runPromise(world.hub.runSessionCommand(thread.id, { _tag: "prompt", text: "hi" }));
    // The run settles to idle with the env ready; the timer then fires.
    await Effect.runPromise(waitFor(() => world.provisioner.released.includes(thread.id)));
    const info = await Effect.runPromise(world.hub.getThread(thread.id));
    expect(info.env).toBe("stopped");
    const last = world.events
      .filter((event) => event._tag === "thread_changed")
      .map((event) => event.thread)
      .at(-1);
    expect(last?.env).toBe("stopped");
  });

  it("resumes on the next prompt: the env comes back ready and stops again after idle", async () => {
    const world = await makeWorld();
    scriptPrompt(world, "hi");
    const thread = await Effect.runPromise(
      world.hub.createThread({ mode: "sandbox", name: "boxed" }),
    );
    await Effect.runPromise(world.hub.runSessionCommand(thread.id, { _tag: "prompt", text: "hi" }));
    await Effect.runPromise(waitFor(() => world.provisioner.released.includes(thread.id)));

    // The next prompt provisions (resumes) the stopped box.
    await Effect.runPromise(
      world.hub.runSessionCommand(thread.id, { _tag: "prompt", text: "again" }),
    );
    await Effect.runPromise(
      waitFor(() => {
        const latest = world.events
          .filter((event) => event._tag === "thread_changed")
          .map((event) => event.thread)
          .at(-1);
        return latest?.id === thread.id && latest?.env === "ready";
      }),
    );
    // And the idle window closes it again.
    await Effect.runPromise(waitFor(() => world.provisioner.released.length >= 2));
  });

  it("never stops a local thread's env", async () => {
    const world = await makeWorld();
    scriptPrompt(world, "hi");
    const thread = await Effect.runPromise(
      world.hub.createThread({ mode: "local", name: "local" }),
    );
    await Effect.runPromise(world.hub.runSessionCommand(thread.id, { _tag: "prompt", text: "hi" }));
    await sleep(IDLE_MS * 3);
    expect(world.provisioner.released).toHaveLength(0);
    const info = await Effect.runPromise(world.hub.getThread(thread.id));
    expect(info.env).toBe("ready");
  });

  it("resets the idle window on activity: a prompt shortly before the deadline stops it later", async () => {
    const world = await makeWorld();
    scriptPrompt(world, "hi");
    const thread = await Effect.runPromise(
      world.hub.createThread({ mode: "sandbox", name: "boxed" }),
    );
    await Effect.runPromise(world.hub.runSessionCommand(thread.id, { _tag: "prompt", text: "hi" }));
    await Effect.runPromise(waitFor(() => world.provisioner.released.length === 1));
    // Activity resets the window: the second stop needs a fresh idle span.
    await Effect.runPromise(
      world.hub.runSessionCommand(thread.id, { _tag: "prompt", text: "again" }),
    );
    await sleep(IDLE_MS / 2);
    expect(world.provisioner.released.length).toBe(1);
    await Effect.runPromise(waitFor(() => world.provisioner.released.length === 2));
  });
});

/**
 * The policy's contract, driven directly (no hub): `IdleStop.make` with
 * scripted registry/provisioner/workerRef fakes and a fake controller
 * (the thread DO's durable-alarm seam) — the arm gates, the reset, and
 * the fire path, without the hub's wiring in between.
 */

/** A fake controller recording arm/disarm (the thread DO's alarm seam). */
const fakeController = () => {
  const armed: string[] = [];
  const disarmed: string[] = [];
  return {
    armed,
    controller: {
      arm: (threadId: string) =>
        Effect.sync(() => {
          armed.push(threadId);
        }),
      disarm: (threadId: string) =>
        Effect.sync(() => {
          disarmed.push(threadId);
        }),
    },
    disarmed,
  };
};

describe("IdleStop.make — the policy directly", () => {
  const THREAD = "thread_policy";
  const HANDLE: EnvHandle = { token: "env-token", url: "ws://127.0.0.1:1" };

  interface PolicyWorld {
    readonly idleStop: IdleStopApi;
    readonly released: {
      threadId: string;
      remoteMachineId: string | null;
      handle: EnvHandle | null;
    }[];
    readonly handles: { threadId: string; handle: EnvHandle | null }[];
    readonly envs: { threadId: string; env: ThreadEnvState }[];
    readonly changed: ThreadInfo[];
  }

  /** Build the policy with scripted fakes (the registry answers the gates). */
  const makePolicy = async (options: {
    mode?: ThreadMode;
    env?: ThreadEnvState;
    state?: ThreadState;
    controller?: IdleStopController;
    idleStopMs?: number;
  }) => {
    const record: HubRecord = {
      autoName: false,
      createdAt: 0,
      cwd: null,
      env: options.env ?? "ready",
      envHandle: HANDLE,
      id: THREAD,
      mode: options.mode ?? "sandbox",
      name: "boxed",
      remoteMachineId: "machine_policy",
      sessionId: null,
    };
    const released: PolicyWorld["released"] = [];
    const handles: PolicyWorld["handles"] = [];
    const envs: PolicyWorld["envs"] = [];
    const changed: ThreadInfo[] = [];
    const registry = {
      get: () => Effect.succeed(Option.some(record)),
      setEnv: (threadId: string, env: ThreadEnvState) =>
        Effect.sync(() => {
          record.env = env;
          envs.push({ env, threadId });
          return Option.some(record);
        }),
      toInfo: () =>
        Effect.succeed(
          Option.some({
            cwd: record.cwd,
            env: record.env,
            id: record.id,
            mode: record.mode,
            name: record.name,
            sessionId: null,
            state: options.state ?? "idle",
            tailSeq: 0,
          } satisfies ThreadInfo),
        ),
    };
    return await Effect.runPromise(
      IdleStop.make({
        controller: options.controller,
        emitThreadChanged: (thread) => Effect.sync(() => changed.push(thread)),
        idleStopMs: options.idleStopMs ?? IDLE_MS,
        infoOf: Effect.fn("infoOf")(function* (threadId) {
          const info = yield* registry.toInfo(threadId);
          if (Option.isNone(info)) {
            return yield* Effect.fail(
              new HubError({ kind: "registry", message: `unknown thread: ${threadId}` }),
            );
          }
          return info.value;
        }),
        provisioner: {
          release: (threadId, remoteMachineId, handle) =>
            Effect.sync(() => {
              released.push({ handle, remoteMachineId, threadId });
            }),
        },
        registry,
        workerRef: {
          setEnvHandle: (threadId, handle) =>
            Effect.sync(() => {
              handles.push({ handle, threadId });
            }),
        },
      }).pipe(Effect.map((idleStop) => ({ changed, envs, handles, idleStop, released }))),
    );
  };

  it("arms a ready idle sandbox thread (the controller gets the arm)", async () => {
    const controller = fakeController();
    const { idleStop } = await makePolicy({ controller: controller.controller });
    await Effect.runPromise(idleStop.arm(THREAD));
    expect(controller.armed).toEqual([THREAD]);
  });

  it("never arms a local thread", async () => {
    const controller = fakeController();
    const { idleStop } = await makePolicy({ controller: controller.controller, mode: "local" });
    await Effect.runPromise(idleStop.arm(THREAD));
    expect(controller.armed).toEqual([]);
  });

  it("never arms a non-ready env", async () => {
    await Promise.all(
      (["stopped", "error", "provisioning"] as const).map(async (env) => {
        const controller = fakeController();
        const { idleStop } = await makePolicy({ controller: controller.controller, env });
        await Effect.runPromise(idleStop.arm(THREAD));
        expect(controller.armed).toEqual([]);
      }),
    );
  });

  it("never arms mid-run (the run's own reports re-arm)", async () => {
    const controller = fakeController();
    const { idleStop } = await makePolicy({ controller: controller.controller, state: "working" });
    await Effect.runPromise(idleStop.arm(THREAD));
    expect(controller.armed).toEqual([]);
  });

  it("disarms through the controller", async () => {
    const controller = fakeController();
    const { idleStop } = await makePolicy({ controller: controller.controller });
    await Effect.runPromise(idleStop.disarm(THREAD));
    expect(controller.disarmed).toEqual([THREAD]);
  });

  it("resets the window on activity: a re-arm pushes the deadline out", async () => {
    const { idleStop, released } = await makePolicy({});
    await Effect.runPromise(idleStop.arm(THREAD));
    await sleep(IDLE_MS / 2);
    // Activity resets the window: the first deadline passes, the second hasn't.
    await Effect.runPromise(idleStop.arm(THREAD));
    await sleep(IDLE_MS / 2);
    expect(released).toHaveLength(0);
    await Effect.runPromise(waitFor(() => released.length === 1));
  });

  it("disarming clears the hub timer", async () => {
    const { idleStop, released } = await makePolicy({});
    await Effect.runPromise(idleStop.arm(THREAD));
    await Effect.runPromise(idleStop.disarm(THREAD));
    await sleep(IDLE_MS * 2);
    expect(released).toHaveLength(0);
  });

  it("fires: releases the env, clears the worker's handle, flips the axis, broadcasts", async () => {
    const { idleStop, released, handles, envs, changed } = await makePolicy({});
    await Effect.runPromise(idleStop.fire(THREAD));
    expect(released).toEqual([
      { handle: HANDLE, remoteMachineId: "machine_policy", threadId: THREAD },
    ]);
    expect(handles).toEqual([{ handle: null, threadId: THREAD }]);
    expect(envs).toEqual([{ env: "stopped", threadId: THREAD }]);
    expect(changed).toHaveLength(1);
    expect(changed[0].env).toBe("stopped");
  });

  it("does not fire mid-run (a command won the race): disarm, no release", async () => {
    const controller = fakeController();
    const { idleStop, released } = await makePolicy({
      controller: controller.controller,
      state: "working",
    });
    await Effect.runPromise(idleStop.fire(THREAD));
    expect(controller.disarmed).toEqual([THREAD]);
    // The re-arm attempt is a no-op while the run is in flight (arm's own
    // gate skips working threads); the run's reports re-arm when it settles.
    expect(controller.armed).toEqual([]);
    expect(released).toHaveLength(0);
  });

  it("fires nothing for a local thread", async () => {
    const { idleStop, released, handles, envs, changed } = await makePolicy({ mode: "local" });
    await Effect.runPromise(idleStop.fire(THREAD));
    expect(released).toHaveLength(0);
    expect(handles).toHaveLength(0);
    expect(envs).toHaveLength(0);
    expect(changed).toHaveLength(0);
  });
});
