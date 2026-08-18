/**
 * The idle-stop policy (idle-stop.ts): a ready sandbox env that has been
 * idle is suspended by the hub (snapshot, billing paused) and resumed on
 * the next prompt; local envs never stop (ADR 0003).
 *
 * The policy is the hub's hidden sub-machine, extracted from the core
 * (hub.ts) into its own module: `arm` starts the window (sandbox mode +
 * env ready + state idle), `disarm` clears it (any activity resets the
 * window), and `fire` — the trigger — validates, suspends the remote
 * machine, flips the env axis, and broadcasts. The hub arms/disarms on every
 * activity signal
 * (worker reports, session events, the env gate) and delegates its public
 * `idleStopFired` (the deployment's DO-alarm trigger) to `fire`.
 *
 * Two timer backends behind the `controller` seam: the hub-side
 * `setTimeout` map by default (the local spine, tests), or a controller
 * that arms the thread DO's durable alarm instead — same semantics,
 * survives hibernation (ADR 0003: the worker arms the timer; the hub
 * pulls the trigger).
 */

import { Context, Effect, Option, Ref } from "effect";
import type { ThreadInfo } from "@saku/wire";

import type { HubError } from "./hub-error.ts";
import type { HubRegistryApi } from "./registry.ts";
import type { EnvProvisioner } from "./provisioner.ts";
import type { ThreadWorkerRef } from "./worker-ref.ts";

/** The no-op stand-in for the mutual-recursive `fire` binding's initial value (never observable). */
const onFireBeforeAssignment = () => Effect.void;

/** Arm/disarm one thread's idle-stop window (the hub owns the policy). */
export interface IdleStopController {
  readonly arm: (threadId: string) => Effect.Effect<void, HubError>;
  readonly disarm: (threadId: string) => Effect.Effect<void>;
}

export interface IdleStopDeps {
  /** The policy gates on the record (mode, env axis) and the state cache. */
  readonly registry: Pick<HubRegistryApi, "get" | "toInfo" | "setEnv">;
  /** Release: suspend the remote machine when the window fires. */
  readonly provisioner: Pick<EnvProvisioner, "release">;
  /** Clear the worker's env handle on fire (the env connection died with the machine). */
  readonly workerRef: Pick<ThreadWorkerRef, "setEnvHandle">;
  /** The thread's wire view; `fire` broadcasts it after the env flip. */
  readonly infoOf: (threadId: string) => Effect.Effect<ThreadInfo, HubError>;
  /** The hub's fan-out (the wire server's `thread_changed` broadcasts). */
  readonly emitThreadChanged: (thread: ThreadInfo) => Effect.Effect<void>;
  /** Idle before a sandbox env is suspended; the hub supplies the default. */
  readonly idleStopMs: number;
  /**
   * The timer seam: defaults to hub-side timers (the local spine, tests);
   * the DO adapter passes a controller that arms the thread DO's durable
   * alarm instead — same semantics, survives hibernation.
   */
  readonly controller?: IdleStopController | undefined;
}

export interface IdleStopApi {
  /** Arm the window: sandbox + env ready + state idle → timer/alarm. */
  readonly arm: (threadId: string) => Effect.Effect<void, HubError>;
  /** Clear the window (any activity, thread teardown, before fire). */
  readonly disarm: (threadId: string) => Effect.Effect<void>;
  /** The trigger: validate, release, clear the handle, flip the env axis, broadcast. */
  readonly fire: (threadId: string) => Effect.Effect<void, HubError>;
  /** Clear every hub-side timer (hub close; the controller's alarms die with the thread DOs). */
  readonly close: Effect.Effect<void>;
}

/** The idle-stop policy: `IdleStop.make(deps)` arms the window per sandbox thread. */
export class IdleStop extends Context.Service<IdleStop, IdleStopApi>()("IdleStop", {
  make: Effect.fn("IdleStop.make")(function* (deps: IdleStopDeps) {
    const { registry, provisioner, workerRef, infoOf, emitThreadChanged } = deps;
    const { controller } = deps;
    const timersRef = yield* Ref.make<Map<string, NodeJS.Timeout>>(new Map());
    // `fire` re-arms the window when a run starts between the timer firing
    // and the fire effect running, while `arm` schedules that fire — mutual
    // recursion, so the binding is initialized with a no-op stand-in here and
    // replaced by the real policy below, after `arm`'s definition.
    let fire: IdleStopApi["fire"] = onFireBeforeAssignment;

    const arm = Effect.fn("arm")(function* (threadId: string) {
      const record = yield* registry.get(threadId);
      if (Option.isNone(record)) {
        return;
      }
      // Local envs never stop (ADR 0003).
      if (record.value.mode !== "sandbox" || record.value.env !== "ready") {
        return;
      }
      // Never while a run is in flight: the run's own reports re-arm.
      const state = yield* registry.toInfo(threadId);
      if (Option.isSome(state) && state.value.state !== "idle") {
        return;
      }
      if (controller !== undefined) {
        // The thread DO's durable alarm: setAlarm replaces, clears, fires.
        yield* controller.arm(threadId);
        return;
      }
      // Any activity resets the window: clear and re-arm.
      const timers = yield* Ref.get(timersRef);
      clearTimeout(timers.get(threadId));
      const timer = setTimeout(() => {
        // The forked fire is best-effort from the timer's perspective: a
        // failing fire (release/handle errors are already swallowed inside)
        // must not surface as an unhandled fiber error.
        void Effect.runFork(
          fire(threadId).pipe(
            Effect.catchIf(
              () => true,
              () => Effect.void,
            ),
          ),
        );
      }, deps.idleStopMs);
      yield* Ref.update(timersRef, (map) => new Map(map).set(threadId, timer));
    });

    const disarm = Effect.fn("disarm")(function* (threadId: string) {
      if (controller !== undefined) {
        yield* controller.disarm(threadId);
        return;
      }
      const timers = yield* Ref.get(timersRef);
      const timer = timers.get(threadId);
      if (timer === undefined) {
        return;
      }
      clearTimeout(timer);
      yield* Ref.update(timersRef, (map) => {
        const next = new Map(map);
        next.delete(threadId);
        return next;
      });
    });

    /** The idle-stop trigger: suspend the remote machine, flip the env axis, broadcast. */
    fire = Effect.fn("fire")(function* (threadId: string) {
      yield* disarm(threadId);
      const record = yield* registry.get(threadId);
      if (Option.isNone(record)) {
        return;
      }
      // Never mid-run: a command could have started between the timer
      // firing and this effect running.
      const info = yield* registry.toInfo(threadId);
      if (Option.isSome(info) && info.value.state !== "idle") {
        yield* arm(threadId);
        return;
      }
      if (record.value.mode !== "sandbox" || record.value.env !== "ready") {
        return;
      }
      yield* provisioner
        .release(threadId, record.value.remoteMachineId, record.value.envHandle)
        .pipe(Effect.catch(() => Effect.void));
      // The worker's env connection is dead with the remote machine: clear it.
      yield* workerRef.setEnvHandle(threadId, null).pipe(Effect.catch(() => Effect.void));
      yield* registry.setEnv(threadId, "stopped");
      const after = yield* infoOf(threadId);
      yield* emitThreadChanged(after);
    });

    const close = Ref.get(timersRef).pipe(
      Effect.tap((timers) =>
        Effect.sync(() => {
          for (const timer of timers.values()) {
            clearTimeout(timer);
          }
        }),
      ),
      Effect.andThen(Ref.set(timersRef, new Map())),
    );

    return { arm, close, disarm, fire };
  }),
}) {}
