/**
 * Idle-stop (ADR 0003): a sandbox env that has been idle is stopped by
 * the hub (snapshot, billing paused) and resumed on the next prompt;
 * local envs never stop. The timer is armed when a ready sandbox thread
 * is idle, reset by any activity (commands, events, worker reports), and
 * fires → the provisioner's release + env axis `stopped`, broadcast.
 *
 * Two suites: the hub-level transitions (below) over real timers with a
 * short window (60 ms), and the policy's contract directly (the second
 * describe) — `makeIdleStop` driven with scripted fakes and a fake
 * controller, covering the arm/disarm/reset/fire transitions without
 * clock flakiness.
 */

import { describe, expect, it } from "vitest";
import { Effect, Option, Schema } from "effect";

import type { EnvHandle } from "@saku/env";
import type { ThreadEnvState, ThreadInfo, ThreadMode, ThreadState } from "@saku/wire";

import { makeHubError } from "../src/hub-error.ts";

import {
  makeHub,
  makeHubRegistry,
  makeIdleStop,
  makeSkillsStore,
  type HubEvent,
  type HubRecord,
  type HubShape,
  type IdleStop,
  type IdleStopController,
} from "../src/index.ts";
import { scriptedProvisioner, scriptedWorker } from "./mock-worker.ts";
import { KvStore } from "@saku/store";

const IDLE_MS = 60;

/** A polling assertion that gave up (the async fork hadn't landed in time). */
class TestError extends Schema.TaggedError<TestError>()("TestError", {
  message: Schema.String,
}) {}

const run = <A, E extends Error>(effect: Effect.Effect<A, E, never>): Promise<A> =>
  Effect.runPromise(effect);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (fn: () => boolean, timeoutMs = 2000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(5);
  }
  throw new TestError({ message: "condition not met" });
};

interface World {
  readonly hub: HubShape;
  readonly worker: ReturnType<typeof scriptedWorker>;
  readonly provisioner: ReturnType<typeof scriptedProvisioner>;
  readonly events: HubEvent[];
}

const makeWorld = async (): Promise<World> => {
  const world = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* makeHubRegistry().pipe(Effect.provide(KvStore.memory()));
      const skills = yield* makeSkillsStore().pipe(Effect.provide(KvStore.memory()));
      const worker = scriptedWorker();
      const provisioner = scriptedProvisioner();
      const hub = yield* makeHub({
        registry,
        skills,
        workerRef: worker.ref,
        provisioner,
        idleStopMs: IDLE_MS,
      });
      worker.attach(hub.events);
      const events: HubEvent[] = [];
      hub.subscribe((event) => events.push(event));
      return { hub, worker, provisioner, events };
    }),
  );
  return world;
};

/** Script a prompt that reports working → idle (the mock worker's habit). */
const scriptPrompt = (world: World, text: string): void => {
  world.worker.onCommand((threadId, command) => {
    if (command._tag !== "prompt") {
      return Effect.fail(makeHubError("command", `unscripted command: ${command._tag}`));
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
    const thread = await run(world.hub.createThread({ name: "boxed", mode: "sandbox" }));
    await run(world.hub.runSessionCommand(thread.id, { _tag: "prompt", text: "hi" }));
    // The run settles to idle with the env ready; the timer then fires.
    await waitFor(() => world.provisioner.released.includes(thread.id));
    const info = await run(world.hub.getThread(thread.id));
    expect(info.env).toBe("stopped");
    const last = world.events
      .filter((event) => event.type === "thread_changed")
      .at(-1) as HubEvent & { type: "thread_changed" };
    expect(last.thread.env).toBe("stopped");
  });

  it("resumes on the next prompt: the env comes back ready and stops again after idle", async () => {
    const world = await makeWorld();
    scriptPrompt(world, "hi");
    const thread = await run(world.hub.createThread({ name: "boxed", mode: "sandbox" }));
    await run(world.hub.runSessionCommand(thread.id, { _tag: "prompt", text: "hi" }));
    await waitFor(() => world.provisioner.released.includes(thread.id));

    // The next prompt provisions (resumes) the stopped box.
    await run(world.hub.runSessionCommand(thread.id, { _tag: "prompt", text: "again" }));
    await waitFor(() => {
      const latest = world.events
        .filter((event) => event.type === "thread_changed")
        .map((event) => (event as { thread: { id: string; env: string } }).thread)
        .filter((t) => t.id === thread.id)
        .at(-1);
      return latest?.env === "ready";
    });
    // And the idle window closes it again.
    await waitFor(() => world.provisioner.released.length >= 2);
  });

  it("never stops a local thread's env", async () => {
    const world = await makeWorld();
    scriptPrompt(world, "hi");
    const thread = await run(world.hub.createThread({ name: "local", mode: "local" }));
    await run(world.hub.runSessionCommand(thread.id, { _tag: "prompt", text: "hi" }));
    await sleep(IDLE_MS * 3);
    expect(world.provisioner.released).toHaveLength(0);
    const info = await run(world.hub.getThread(thread.id));
    expect(info.env).toBe("ready");
  });

  it("resets the idle window on activity: a prompt shortly before the deadline stops it later", async () => {
    const world = await makeWorld();
    scriptPrompt(world, "hi");
    const thread = await run(world.hub.createThread({ name: "boxed", mode: "sandbox" }));
    await run(world.hub.runSessionCommand(thread.id, { _tag: "prompt", text: "hi" }));
    await waitFor(() => world.provisioner.released.length === 1);
    // Activity resets the window: the second stop needs a fresh idle span.
    await run(world.hub.runSessionCommand(thread.id, { _tag: "prompt", text: "again" }));
    await sleep(IDLE_MS / 2);
    expect(world.provisioner.released.length).toBe(1);
    await waitFor(() => world.provisioner.released.length === 2);
  });
});

/**
 * The policy's contract, driven directly (no hub): `makeIdleStop` with
 * scripted registry/provisioner/workerRef fakes and a fake controller
 * (the thread DO's durable-alarm seam) — the arm gates, the reset, and
 * the fire path, without the hub's wiring in between.
 */
describe("makeIdleStop — the policy directly", () => {
  const THREAD = "thread_policy";
  const HANDLE: EnvHandle = { url: "ws://127.0.0.1:1", token: "env-token", boxId: "bx_policy" };

  interface PolicyWorld {
    readonly idleStop: IdleStop;
    readonly released: Array<{ threadId: string; handle: EnvHandle | null }>;
    readonly handles: Array<{ threadId: string; handle: EnvHandle | null }>;
    readonly envs: Array<{ threadId: string; env: ThreadEnvState }>;
    readonly changed: ThreadInfo[];
  }

  /** Build the policy with scripted fakes (the registry answers the gates). */
  const makePolicy = (options: {
    mode?: ThreadMode;
    env?: ThreadEnvState;
    state?: ThreadState;
    controller?: IdleStopController;
    idleStopMs?: number;
  }): Promise<PolicyWorld> => {
    const record: HubRecord = {
      id: THREAD,
      name: "boxed",
      cwd: null,
      mode: options.mode ?? "sandbox",
      autoName: false,
      createdAt: 0,
      sessionId: null,
      env: options.env ?? "ready",
      envHandle: HANDLE,
    };
    const released: PolicyWorld["released"] = [];
    const handles: PolicyWorld["handles"] = [];
    const envs: PolicyWorld["envs"] = [];
    const changed: ThreadInfo[] = [];
    const registry = {
      get: () => Effect.succeed(Option.some(record)),
      toInfo: () =>
        Effect.succeed(
          Option.some({
            id: record.id,
            name: record.name,
            cwd: record.cwd,
            mode: record.mode,
            state: options.state ?? "idle",
            env: record.env,
            sessionId: null,
            tailSeq: 0,
          } satisfies ThreadInfo),
        ),
      setEnv: (threadId: string, env: ThreadEnvState) =>
        Effect.sync(() => {
          record.env = env;
          envs.push({ threadId, env });
          return Option.some(record);
        }),
    };
    return run(
      makeIdleStop({
        registry,
        provisioner: {
          release: (threadId, handle) =>
            Effect.sync(() => {
              released.push({ threadId, handle: Option.getOrNull(handle) });
            }),
        },
        workerRef: {
          setEnvHandle: (threadId, handle) =>
            Effect.sync(() => {
              handles.push({ threadId, handle });
            }),
        },
        infoOf: (threadId) =>
          Effect.gen(function* () {
            const info = yield* registry.toInfo(threadId);
            if (Option.isNone(info)) {
              return yield* Effect.fail(makeHubError("registry", `unknown thread: ${threadId}`));
            }
            return info.value;
          }),
        emitThreadChanged: (thread) => changed.push(thread),
        idleStopMs: options.idleStopMs ?? IDLE_MS,
        controller: options.controller,
      }).pipe(Effect.map((idleStop) => ({ idleStop, released, handles, envs, changed }))),
    );
  };

  /** A fake controller recording arm/disarm (the thread DO's alarm seam). */
  const fakeController = () => {
    const armed: string[] = [];
    const disarmed: string[] = [];
    return {
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
      armed,
      disarmed,
    };
  };

  it("arms a ready idle sandbox thread (the controller gets the arm)", async () => {
    const controller = fakeController();
    const { idleStop } = await makePolicy({ controller: controller.controller });
    await run(idleStop.arm(THREAD));
    expect(controller.armed).toEqual([THREAD]);
  });

  it("never arms a local thread", async () => {
    const controller = fakeController();
    const { idleStop } = await makePolicy({ controller: controller.controller, mode: "local" });
    await run(idleStop.arm(THREAD));
    expect(controller.armed).toEqual([]);
  });

  it("never arms a non-ready env", async () => {
    for (const env of ["stopped", "error", "provisioning"] as const) {
      const controller = fakeController();
      const { idleStop } = await makePolicy({ controller: controller.controller, env });
      await run(idleStop.arm(THREAD));
      expect(controller.armed).toEqual([]);
    }
  });

  it("never arms mid-run (the run's own reports re-arm)", async () => {
    const controller = fakeController();
    const { idleStop } = await makePolicy({ controller: controller.controller, state: "working" });
    await run(idleStop.arm(THREAD));
    expect(controller.armed).toEqual([]);
  });

  it("disarms through the controller", async () => {
    const controller = fakeController();
    const { idleStop } = await makePolicy({ controller: controller.controller });
    await run(idleStop.disarm(THREAD));
    expect(controller.disarmed).toEqual([THREAD]);
  });

  it("resets the window on activity: a re-arm pushes the deadline out", async () => {
    const { idleStop, released } = await makePolicy({});
    await run(idleStop.arm(THREAD));
    await sleep(IDLE_MS / 2);
    // Activity resets the window: the first deadline passes, the second hasn't.
    await run(idleStop.arm(THREAD));
    await sleep(IDLE_MS / 2);
    expect(released).toHaveLength(0);
    await waitFor(() => released.length === 1);
  });

  it("disarming clears the hub timer", async () => {
    const { idleStop, released } = await makePolicy({});
    await run(idleStop.arm(THREAD));
    await run(idleStop.disarm(THREAD));
    await sleep(IDLE_MS * 2);
    expect(released).toHaveLength(0);
  });

  it("fires: releases the env, clears the worker's handle, flips the axis, broadcasts", async () => {
    const { idleStop, released, handles, envs, changed } = await makePolicy({});
    await run(idleStop.fire(THREAD));
    expect(released).toEqual([{ threadId: THREAD, handle: HANDLE }]);
    expect(handles).toEqual([{ threadId: THREAD, handle: null }]);
    expect(envs).toEqual([{ threadId: THREAD, env: "stopped" }]);
    expect(changed).toHaveLength(1);
    expect(changed[0].env).toBe("stopped");
  });

  it("does not fire mid-run (a command won the race): disarm, no release", async () => {
    const controller = fakeController();
    const { idleStop, released } = await makePolicy({
      controller: controller.controller,
      state: "working",
    });
    await run(idleStop.fire(THREAD));
    expect(controller.disarmed).toEqual([THREAD]);
    // The re-arm attempt is a no-op while the run is in flight (arm's own
    // gate skips working threads); the run's reports re-arm when it settles.
    expect(controller.armed).toEqual([]);
    expect(released).toHaveLength(0);
  });

  it("fires nothing for a local thread", async () => {
    const { idleStop, released, handles, envs, changed } = await makePolicy({ mode: "local" });
    await run(idleStop.fire(THREAD));
    expect(released).toHaveLength(0);
    expect(handles).toHaveLength(0);
    expect(envs).toHaveLength(0);
    expect(changed).toHaveLength(0);
  });
});
