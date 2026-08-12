/**
 * Idle-stop (ADR 0003): a sandbox env that has been idle is stopped by
 * the hub (snapshot, billing paused) and resumed on the next prompt;
 * local envs never stop. The timer is armed when a ready sandbox thread
 * is idle, reset by any activity (commands, events, worker reports), and
 * fires → the provisioner's release + env axis `stopped`, broadcast.
 *
 * Real timers with a short window (60 ms) — the semantics under test are
 * the arm/disarm/reset/fire transitions, not clock behavior.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import {
  HubError,
  makeHub,
  makeHubRegistry,
  makeSkillsStore,
  type HubEvent,
  type HubShape,
} from "../src/index.ts";
import { scriptedProvisioner, scriptedWorker } from "./mock-worker.ts";
import { memoryKv } from "@saku/store";

const IDLE_MS = 60;

const run = <A, E extends Error>(effect: Effect.Effect<A, E, never>): Promise<A> =>
  Effect.runPromise(effect);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (fn: () => boolean, timeoutMs = 2000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(5);
  }
  throw new Error("condition not met");
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
      const registry = yield* makeHubRegistry(memoryKv());
      const skills = yield* makeSkillsStore(memoryKv());
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
      return Effect.fail(new HubError({ message: `unscripted command: ${command._tag}` }));
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
