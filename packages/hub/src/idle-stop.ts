/**
 * The idle-stop policy (idle-stop.ts): a ready sandbox env that has been
 * idle is stopped by the hub (snapshot, billing paused) and resumed on
 * the next prompt; local envs never stop (ADR 0003).
 *
 * The policy is the hub's hidden sub-machine, extracted from the core
 * (hub.ts) into its own module: `arm` starts the window (sandbox mode +
 * env ready + state idle), `disarm` clears it (any activity resets the
 * window), and `fire` — the trigger — validates, stops the Box, flips the
 * env axis, and broadcasts. The hub arms/disarms on every activity signal
 * (worker reports, session events, the env gate) and delegates its public
 * `idleStopFired` (the deployment's DO-alarm trigger) to `fire`.
 *
 * Two timer backends behind the `controller` seam: the hub-side
 * `setTimeout` map by default (the local spine, tests), or a controller
 * that arms the thread DO's durable alarm instead — same semantics,
 * survives hibernation (ADR 0003: the worker arms the timer; the hub
 * pulls the trigger).
 */

import { Effect, Option, Ref } from "effect";
import type { ThreadInfo } from "@saku/wire";

import type { HubError } from "./hub-error.ts";
import type { HubRegistryShape } from "./registry.ts";
import type { EnvProvisioner } from "./provisioner.ts";
import type { ThreadWorkerRef } from "./worker-ref.ts";

/** Arm/disarm one thread's idle-stop window (the hub owns the policy). */
export interface IdleStopController {
  readonly arm: (threadId: string) => Effect.Effect<void, HubError, never>;
  readonly disarm: (threadId: string) => Effect.Effect<void, never, never>;
}

export interface IdleStopDeps {
  /** The policy gates on the record (mode, env axis) and the state cache. */
  readonly registry: Pick<HubRegistryShape, "get" | "toInfo" | "setEnv">;
  /** Release: stop the Box when the window fires. */
  readonly provisioner: Pick<EnvProvisioner, "release">;
  /** Clear the worker's env handle on fire (the env connection died with the Box). */
  readonly workerRef: Pick<ThreadWorkerRef, "setEnvHandle">;
  /** The thread's wire view; `fire` broadcasts it after the env flip. */
  readonly infoOf: (threadId: string) => Effect.Effect<ThreadInfo, HubError, never>;
  /** The hub's fan-out (the wire server's `thread_changed` broadcasts). */
  readonly emitThreadChanged: (thread: ThreadInfo) => void;
  /** Idle before a sandbox env is stopped; the hub supplies the default. */
  readonly idleStopMs: number;
  /**
   * The timer seam: defaults to hub-side timers (the local spine, tests);
   * the DO adapter passes a controller that arms the thread DO's durable
   * alarm instead — same semantics, survives hibernation.
   */
  readonly controller?: IdleStopController | undefined;
}

export interface IdleStop {
  /** Arm the window: sandbox + env ready + state idle → timer/alarm. */
  readonly arm: (threadId: string) => Effect.Effect<void, HubError, never>;
  /** Clear the window (any activity, thread teardown, before fire). */
  readonly disarm: (threadId: string) => Effect.Effect<void, never, never>;
  /** The trigger: validate, release, clear the handle, flip the env axis, broadcast. */
  readonly fire: (threadId: string) => Effect.Effect<void, HubError, never>;
  /** Clear every hub-side timer (hub close; the controller's alarms die with the thread DOs). */
  readonly close: Effect.Effect<void, never>;
}

export const makeIdleStop = (deps: IdleStopDeps): Effect.Effect<IdleStop, never, never> =>
  Effect.gen(function* () {
    const { registry, provisioner, workerRef, infoOf, emitThreadChanged } = deps;
    const controller = deps.controller;
    const timersRef = yield* Ref.make<Map<string, NodeJS.Timeout>>(new Map());

    const arm = (threadId: string): Effect.Effect<void, HubError, never> =>
      Effect.gen(function* () {
        const record = yield* registry.get(threadId);
        if (Option.isNone(record)) return;
        // Local envs never stop (ADR 0003).
        if (record.value.mode !== "sandbox" || record.value.env !== "ready") return;
        // Never while a run is in flight: the run's own reports re-arm.
        const state = yield* registry.toInfo(threadId);
        if (Option.isSome(state) && state.value.state !== "idle") return;
        if (controller !== undefined) {
          // The thread DO's durable alarm: setAlarm replaces, clears, fires.
          yield* controller.arm(threadId);
          return;
        }
        // Any activity resets the window: clear and re-arm.
        const timers = yield* Ref.get(timersRef);
        const existing = timers.get(threadId);
        if (existing !== undefined) clearTimeout(existing);
        const timer = setTimeout(() => {
          // The forked fire is best-effort from the timer's perspective: a
          // failing fire (release/handle errors are already swallowed inside)
          // must not surface as an unhandled fiber error.
          void Effect.runFork(fire(threadId).pipe(Effect.catch(() => Effect.void)));
        }, deps.idleStopMs);
        yield* Ref.update(timersRef, (timers) => new Map(timers).set(threadId, timer));
      });

    const disarm = (threadId: string): Effect.Effect<void, never, never> =>
      Effect.gen(function* () {
        if (controller !== undefined) {
          yield* controller.disarm(threadId);
          return;
        }
        const timers = yield* Ref.get(timersRef);
        const timer = timers.get(threadId);
        if (timer === undefined) return;
        clearTimeout(timer);
        yield* Ref.update(timersRef, (timers) => {
          const next = new Map(timers);
          next.delete(threadId);
          return next;
        });
      });

    /** The idle-stop trigger: stop the Box, flip the env axis, broadcast. */
    const fire = (threadId: string): Effect.Effect<void, HubError, never> =>
      Effect.gen(function* () {
        yield* disarm(threadId);
        const record = yield* registry.get(threadId);
        if (Option.isNone(record)) return;
        // Never mid-run: a command could have started between the timer
        // firing and this effect running.
        const info = yield* registry.toInfo(threadId);
        if (Option.isSome(info) && info.value.state !== "idle") {
          yield* arm(threadId);
          return;
        }
        if (record.value.mode !== "sandbox" || record.value.env !== "ready") return;
        yield* provisioner
          .release(threadId, Option.fromNullishOr(record.value.envHandle))
          .pipe(Effect.catch(() => Effect.void));
        // The worker's env connection is dead with the Box: clear it.
        yield* workerRef.setEnvHandle(threadId, null).pipe(Effect.catch(() => Effect.void));
        yield* registry.setEnv(threadId, "stopped");
        const after = yield* infoOf(threadId);
        emitThreadChanged(after);
      });

    const close: Effect.Effect<void, never> = Ref.get(timersRef).pipe(
      Effect.tap((timers) =>
        Effect.sync(() => {
          for (const timer of timers.values()) clearTimeout(timer);
        }),
      ),
      Effect.andThen(Ref.set(timersRef, new Map())),
    );

    return { arm, disarm, fire, close };
  });
