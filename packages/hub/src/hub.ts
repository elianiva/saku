/**
 * The hub core (hub.ts): the control plane of ADR 0001 — the durable
 * thread registry, the worker seam, the env provisioner seam, and the
 * fan-out of `thread_changed` and session events.
 *
 * The core is deliberately transport-free: it answers domain calls
 * (threads, sessions, skills) and pushes `HubEvent`s to subscribers. The
 * wire server (server.ts) adapts it to WebSocket frames; the DO adapter
 * (M4) adapts it to the alchemy entry point. The core owns no sockets and
 * no workers — both are seams (ThreadWorkerRef, EnvProvisioner), so tests
 * script them and production wires them.
 *
 * Command semantics (mirroring the local daemon's proven routing):
 *
 * - hub commands (threads, skills) resolve user-supplied thread ids
 *   (exact name, then unambiguous id prefix) against the registry
 * - session commands are forwarded to the thread's worker; the four
 *   read-only commands (get_entries, get_state, get_available_models,
 *   get_available_thinking_levels) skip the env gate — browsing never
 *   wakes a stopped Box (ADR 0004) — every other session command ensures
 *   the env first (lazy provisioning on first touch, ADR 0003)
 * - worker reports (state, sessionId, auto-title, tailSeq) update the
 *   registry caches and broadcast `thread_changed` when the wire view
 *   actually changed; a user rename (autoName = false) permanently wins
 *   over auto-title reports
 *
 * The idle-stop policy (ADR 0003) lives in idle-stop.ts: the hub arms and
 * disarms the window here on every activity signal (reports, events, the
 * env gate, teardown) and delegates its public `idleStopFired` trigger to
 * the policy's fire path.
 */

import { Effect, Option, Result, Schema } from "effect";
import { READ_ONLY_COMMANDS, resolveThread, ThreadInfo } from "@saku/wire";
import type {
  ResponsePayload,
  SessionCommand,
  SkillInfo,
  SkillScope,
  ThreadMode,
} from "@saku/wire";

import { HubError, makeHubError, messageOf } from "./hub-error.ts";
import { makeIdleStop, type IdleStopController } from "./idle-stop.ts";
import type { EnvProvisioner } from "./provisioner.ts";
import type { HubRecord, HubRegistryShape } from "./registry.ts";
import type { SkillsStoreShape } from "./skills.ts";
import type { HubEventSink, ThreadWorkerRef, WorkerReport } from "./worker-ref.ts";

/** Arm/disarm one thread's idle-stop window (the policy is the hub's). */
export type { IdleStopController } from "./idle-stop.ts";

/** Everything the hub pushes to its subscribers (the server's fan-out). */
export type HubEvent =
  | { readonly type: "thread_changed"; readonly thread: ThreadInfo }
  | { readonly type: "session_event"; readonly threadId: string; readonly event: unknown };
export type HubListener = (event: HubEvent) => void;

export interface HubShape {
  readonly listThreads: () => Effect.Effect<ThreadInfo[], HubError, never>;
  readonly createThread: (input: {
    name: string;
    cwd?: string;
    mode?: ThreadMode;
    autoName?: boolean;
  }) => Effect.Effect<ThreadInfo, HubError, never>;
  readonly getThread: (threadIdInput: string) => Effect.Effect<ThreadInfo, HubError, never>;
  readonly renameThread: (
    threadIdInput: string,
    name: string,
  ) => Effect.Effect<ThreadInfo, HubError, never>;
  /** Delete the thread; returns the removed info (for the broadcast). */
  readonly deleteThread: (threadIdInput: string) => Effect.Effect<ThreadInfo, HubError, never>;
  readonly runSessionCommand: (
    threadIdInput: string,
    command: SessionCommand,
  ) => Effect.Effect<ResponsePayload, HubError, never>;
  readonly listSkills: () => Effect.Effect<readonly SkillInfo[], HubError, never>;
  readonly importSkill: (
    source: string,
    scope?: SkillScope,
  ) => Effect.Effect<SkillInfo, HubError, never>;
  readonly deleteSkill: (id: string) => Effect.Effect<void, HubError, never>;
  /** The worker → hub push channel (give it to the ThreadWorkerRef). */
  readonly events: HubEventSink;
  /**
   * The idle-stop trigger (a DO alarm fired in the thread worker):
   * validate, stop the env, flip the env axis, broadcast.
   */
  readonly idleStopFired: (threadId: string) => Effect.Effect<void, HubError, never>;
  /** Subscribe to thread_changed + session events; returns unsubscribe. */
  readonly subscribe: (listener: HubListener) => () => void;
  /** Shut the hub down: close the worker ref. Best-effort. */
  readonly close: () => Effect.Effect<void, never>;
}

export interface HubDeps {
  readonly registry: HubRegistryShape;
  readonly skills: SkillsStoreShape;
  readonly workerRef: ThreadWorkerRef;
  readonly provisioner: EnvProvisioner;
  /** Idle before a sandbox env is stopped; default 5 minutes (ADR 0003). */
  readonly idleStopMs?: number;
  /**
   * The idle-stop timer seam: defaults to hub-side timers (the local
   * spine, tests); the DO adapter passes a controller that arms the
   * thread DO's durable alarm instead — same semantics, survives
   * hibernation (ADR 0003: the worker arms the timer; the hub pulls the
   * trigger).
   */
  readonly idleStop?: IdleStopController;
}

const isReadOnly = (command: SessionCommand): boolean => READ_ONLY_COMMANDS.has(command._tag);

/** Structural equality over the wire's thread view (not JSON.stringify). */
const threadInfoEq = Schema.toEquivalence(ThreadInfo);

/** Resolve a user-supplied thread id/name/prefix against the registry. */
const resolveThreadId = Effect.fn("resolveThreadId")(function* (
  registry: HubRegistryShape,
  input: string,
) {
  const threads = yield* registry.list();
  const resolved = resolveThread(threads, input);
  if (Result.isFailure(resolved)) {
    return yield* Effect.fail(makeHubError("resolution", resolved.failure));
  }
  return resolved.success.id;
});

export const makeHub = Effect.fn("makeHub")(function* (deps: HubDeps) {
  const { registry, skills, workerRef, provisioner } = deps;
  // Listeners are sync callbacks (the server forks its own broadcasts);
  // one plain synchronous set, shared by notify/subscribe/unsubscribe —
  // no runSync/runFork discipline split on the same structure.
  const listeners = new Set<HubListener>();

  const notify = Effect.fn("notify")(function* (event: HubEvent) {
    // A throwing listener must not take the hub down. The snapshot keeps
    // a listener that unsubscribes itself mid-notify from starving others.
    for (const listener of Array.from(listeners)) {
      const result = Result.try(() => listener(event));
      if (Result.isFailure(result)) {
        yield* Effect.logWarning(`[hub] listener failed: ${messageOf(result.failure)}`);
      }
    }
  });

  const emitThreadChanged = (thread: ThreadInfo): Effect.Effect<void, never, never> =>
    notify({ type: "thread_changed", thread });

  const infoOf = Effect.fn("infoOf")(function* (threadId: string) {
    const info = yield* registry.toInfo(threadId);
    if (Option.isNone(info)) {
      return yield* Effect.fail(makeHubError("registry", `unknown thread: ${threadId}`));
    }
    return info.value;
  });

  // Idle-stop: the timer is armed when a sandbox thread is idle with a
  // ready env, disarmed on activity, and fires → the hub stops the Box
  // (ADR 0003: the worker arms the timer; the hub pulls the trigger —
  // the DO alarm of M4 replaces this hub-side timer, same semantics,
  // via the `idleStop` controller).
  const idleStop = yield* makeIdleStop({
    registry,
    provisioner,
    workerRef,
    infoOf,
    emitThreadChanged,
    idleStopMs: deps.idleStopMs ?? 5 * 60 * 1000,
    controller: deps.idleStop,
  });

  /** Apply a worker report; broadcast when the wire view changed. */
  const applyReport = Effect.fn("applyReport")(function* (threadId: string, report: WorkerReport) {
    const before = yield* registry.toInfo(threadId);
    // Auto-title: applied only while the name is still auto-generated;
    // a user rename (autoName = false) wins forever (CONTEXT.md: Auto-title).
    if (report.name !== undefined) {
      const record = yield* registry.get(threadId);
      if (Option.isSome(record) && record.value.autoName) {
        yield* registry.update(threadId, { name: report.name, autoName: false });
      }
    }
    if (report.sessionId !== undefined) {
      yield* registry.update(threadId, { sessionId: report.sessionId });
    }
    if (report.state !== undefined) {
      yield* registry.setState(threadId, report.state);
    }
    if (report.tailSeq !== undefined) {
      yield* registry.setTailSeq(threadId, report.tailSeq);
    }
    // Idle-stop: arm when the worker reports idle, disarm while working.
    if (report.state === "working") {
      yield* idleStop.disarm(threadId);
    } else if (report.state === "idle") {
      yield* idleStop.arm(threadId);
    }
    const after = yield* registry.toInfo(threadId);
    if (Option.isSome(before) && Option.isSome(after) && !threadInfoEq(before.value, after.value)) {
      yield* emitThreadChanged(after.value);
    }
  });
  const events: HubEventSink = {
    sessionEvent: (threadId, event, tailSeq) => {
      // Fire-and-forget pushes: a failing arm (the controller's alarm
      // channel) must not surface as an unhandled fiber error.
      void Effect.runFork(
        Effect.gen(function* () {
          yield* registry.setTailSeq(threadId, tailSeq);
          // Any event is activity: reset the idle timer.
          yield* idleStop.arm(threadId);
          yield* notify({ type: "session_event", threadId, event });
        }).pipe(Effect.catch(() => Effect.void)),
      );
    },
    report: (threadId, report) => {
      void Effect.runFork(applyReport(threadId, report).pipe(Effect.catch(() => Effect.void)));
    },
  };

  /** The env gate: a non-ready env is provisioned before the command runs. */
  const ensureEnv = Effect.fn("ensureEnv")(function* (thread: HubRecord) {
    if (thread.env === "ready") {
      // The worker may have restarted since provisioning (a DO activation
      // loses its in-memory handle): re-push the persisted handle.
      yield* workerRef
        .setEnvHandle(thread.id, Option.getOrNull(Option.fromNullishOr(thread.envHandle)))
        .pipe(Effect.catch(() => Effect.void));
      // Activity on a ready env resets the idle timer.
      yield* idleStop.arm(thread.id);
      return;
    }
    yield* idleStop.disarm(thread.id);
    const outcome = yield* provisioner
      .ensure(thread, Option.fromNullishOr(thread.envHandle))
      .pipe(Effect.result);
    if (Result.isFailure(outcome)) {
      yield* registry.setEnv(thread.id, "error");
      const info = yield* infoOf(thread.id);
      yield* emitThreadChanged(info);
      return yield* Effect.fail(makeHubError("provisioner", outcome.failure.message));
    }
    if (Option.isSome(outcome.success)) {
      yield* registry.setEnvHandle(thread.id, outcome.success.value);
    }
    yield* registry.setEnv(thread.id, "ready");
    // The worker's env connection follows the handle.
    yield* workerRef
      .setEnvHandle(thread.id, Option.getOrNull(outcome.success))
      .pipe(Effect.catch(() => Effect.void));
    const info = yield* infoOf(thread.id);
    yield* emitThreadChanged(info);
    // The thread is idle until the command runs: arm the timer now.
    yield* idleStop.arm(thread.id);
  });

  return {
    listThreads: Effect.fn("listThreads")(function* () {
      const records = yield* registry.list();
      // Independent reads; the order of results follows the records.
      return yield* Effect.forEach(records, (record) => infoOf(record.id), {
        concurrency: "unbounded",
      });
    }),
    createThread: Effect.fn("createThread")(function* (input: {
      name: string;
      cwd?: string;
      mode?: ThreadMode;
      autoName?: boolean;
    }) {
      const record = yield* registry.create(input);
      const workerCreated = yield* workerRef.create(record.id, record).pipe(Effect.result);
      if (Result.isFailure(workerCreated)) {
        // Roll back: a thread whose worker cannot exist must not exist.
        yield* registry.delete(record.id);
        return yield* Effect.fail(
          makeHubError("worker", `failed to create worker: ${workerCreated.failure.message}`),
        );
      }
      const info = yield* infoOf(record.id);
      yield* emitThreadChanged(info);
      return info;
    }),
    getThread: Effect.fn("getThread")(function* (threadIdInput: string) {
      const threadId = yield* resolveThreadId(registry, threadIdInput);
      return yield* infoOf(threadId);
    }),
    renameThread: Effect.fn("renameThread")(function* (threadIdInput: string, name: string) {
      const threadId = yield* resolveThreadId(registry, threadIdInput);
      const trimmed = name.trim();
      if (trimmed.length === 0) {
        return yield* Effect.fail(makeHubError("command", "name must not be empty"));
      }
      // A user rename wins over auto-title forever (CONTEXT.md: Auto-title).
      yield* registry.update(threadId, { name: trimmed, autoName: false });
      const info = yield* infoOf(threadId);
      yield* emitThreadChanged(info);
      return info;
    }),
    deleteThread: Effect.fn("deleteThread")(function* (threadIdInput: string) {
      const threadId = yield* resolveThreadId(registry, threadIdInput);
      const info = yield* infoOf(threadId);
      const record = yield* registry.get(threadId);
      // Best-effort teardown: the record is gone either way.
      yield* workerRef.delete(threadId).pipe(Effect.catch(() => Effect.void));
      if (Option.isSome(record)) {
        yield* idleStop.disarm(threadId);
        yield* provisioner
          .release(threadId, Option.fromNullishOr(record.value.envHandle))
          .pipe(Effect.catch(() => Effect.void));
      }
      yield* registry.delete(threadId);
      yield* emitThreadChanged(info);
      return info;
    }),
    runSessionCommand: Effect.fn("runSessionCommand")(function* (
      threadIdInput: string,
      command: SessionCommand,
    ) {
      const threadId = yield* resolveThreadId(registry, threadIdInput);
      const record = yield* registry.get(threadId);
      if (Option.isNone(record)) {
        return yield* Effect.fail(makeHubError("registry", `unknown thread: ${threadId}`));
      }
      // Reads never wake an env; everything else gates on it.
      if (!isReadOnly(command)) {
        yield* ensureEnv(record.value);
      }
      const result = yield* workerRef.command(threadId, command);
      yield* registry.setTailSeq(threadId, result.tailSeq);
      return result.payload;
    }),
    listSkills: () => skills.list(),
    importSkill: (source: string, scope?: SkillScope) =>
      skills.import({ source, ...(scope === undefined ? {} : { scope }) }),
    deleteSkill: Effect.fn("deleteSkill")(function* (id: string) {
      const deleted = yield* skills.delete(id);
      if (!deleted) {
        return yield* Effect.fail(makeHubError("skills", `unknown skill: ${id}`));
      }
    }),
    events,
    idleStopFired: (threadId: string) => idleStop.fire(threadId),
    subscribe: (listener: HubListener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: Effect.fn("close")(function* () {
      // The policy's hub-side timers are cleared here (the controller's
      // durable alarms die with the thread DOs).
      yield* idleStop.close;
      yield* workerRef.close().pipe(Effect.catch(() => Effect.void));
    }),
  };
});
