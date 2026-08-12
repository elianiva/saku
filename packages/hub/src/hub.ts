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
 */

import { Effect, Option, Ref } from "effect";
import type {
  ResponsePayload,
  SessionCommand,
  SkillInfo,
  SkillScope,
  ThreadInfo,
  ThreadMode,
} from "@saku/wire";
import { resolveThread } from "@saku/wire";
import { Result } from "effect";

import { HubError, messageOf } from "./hub-error.ts";
import type { EnvProvisioner } from "./provisioner.ts";
import type { HubRecord, HubRegistryShape } from "./registry.ts";
import type { SkillsStoreShape } from "./skills.ts";
import type { HubEventSink, ThreadWorkerRef, WorkerReport } from "./worker-ref.ts";

/** Everything the hub pushes to its subscribers (the server's fan-out). */
export type HubEvent =
  | { readonly type: "thread_changed"; readonly thread: ThreadInfo }
  | { readonly type: "session_event"; readonly threadId: string; readonly event: unknown };
export type HubListener = (event: HubEvent) => void;

export interface HubShape {
  // -- threads
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
  // -- sessions
  readonly runSessionCommand: (
    threadIdInput: string,
    command: SessionCommand,
  ) => Effect.Effect<ResponsePayload, HubError, never>;
  // -- skills
  readonly listSkills: () => Effect.Effect<readonly SkillInfo[], HubError, never>;
  readonly importSkill: (
    source: string,
    scope?: SkillScope,
  ) => Effect.Effect<SkillInfo, HubError, never>;
  readonly deleteSkill: (id: string) => Effect.Effect<void, HubError, never>;
  /** The worker → hub push channel (give it to the ThreadWorkerRef). */
  readonly events: HubEventSink;
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
}

/** The reads that never start a session or wake an env (ADR 0004). */
const READ_ONLY_COMMANDS = new Set<SessionCommand["_tag"]>([
  "get_entries",
  "get_state",
  "get_available_models",
  "get_available_thinking_levels",
]);

const isReadOnly = (command: SessionCommand): boolean => READ_ONLY_COMMANDS.has(command._tag);

/** Resolve a user-supplied thread id/name/prefix against the registry. */
const resolveThreadId = (
  registry: HubRegistryShape,
  input: string,
): Effect.Effect<string, HubError, never> =>
  Effect.gen(function* () {
    const threads = yield* registry.list();
    const resolved = resolveThread(threads, input);
    if (Result.isFailure(resolved)) {
      return yield* Effect.fail(new HubError({ message: resolved.failure }));
    }
    return resolved.success.id;
  });

export const makeHub = (deps: HubDeps): Effect.Effect<HubShape, never, never> =>
  Effect.gen(function* () {
    const { registry, skills, workerRef, provisioner } = deps;
    // Idle-stop: the timer is armed when a sandbox thread is idle with a
    // ready env, disarmed on activity, and fires → the hub stops the Box
    // (ADR 0003: the worker arms the timer; the hub pulls the trigger —
    // the DO alarm of M4 replaces this hub-side timer, same semantics).
    const idleStopMs = deps.idleStopMs ?? 5 * 60 * 1000;
    const idleTimersRef = yield* Ref.make<Map<string, NodeJS.Timeout>>(new Map());

    const armIdleStop = (threadId: string): Effect.Effect<void, HubError, never> =>
      Effect.gen(function* () {
        const record = yield* registry.get(threadId);
        if (Option.isNone(record)) return;
        // Local envs never stop (ADR 0003).
        if (record.value.mode !== "sandbox" || record.value.env !== "ready") return;
        // Never while a run is in flight: the run's own reports re-arm.
        const state = yield* registry.toInfo(threadId);
        if (Option.isSome(state) && state.value.state !== "idle") return;
        // Any activity resets the window: clear and re-arm.
        const timers = yield* Ref.get(idleTimersRef);
        const existing = timers.get(threadId);
        if (existing !== undefined) clearTimeout(existing);
        const timer = setTimeout(() => {
          void Effect.runFork(fireIdleStop(threadId));
        }, idleStopMs);
        yield* Ref.update(idleTimersRef, (timers) => new Map(timers).set(threadId, timer));
      });

    const disarmIdleStop = (threadId: string): Effect.Effect<void, never, never> =>
      Ref.get(idleTimersRef).pipe(
        Effect.flatMap((timers) => {
          const timer = timers.get(threadId);
          if (timer === undefined) return Effect.void;
          clearTimeout(timer);
          return Ref.update(idleTimersRef, (timers) => {
            const next = new Map(timers);
            next.delete(threadId);
            return next;
          });
        }),
      );

    /** The idle-stop trigger: stop the Box, flip the env axis, broadcast. */
    const fireIdleStop = (threadId: string): Effect.Effect<void, HubError, never> =>
      Effect.gen(function* () {
        yield* disarmIdleStop(threadId);
        const record = yield* registry.get(threadId);
        if (Option.isNone(record)) return;
        // Never mid-run: a command could have started between the timer
        // firing and this effect running.
        const info = yield* registry.toInfo(threadId);
        if (Option.isSome(info) && info.value.state !== "idle") {
          yield* armIdleStop(threadId);
          return;
        }
        if (record.value.mode !== "sandbox" || record.value.env !== "ready") return;
        yield* provisioner
          .release(threadId, Option.fromNullishOr(record.value.envHandle))
          .pipe(Effect.catch(() => Effect.void));
        yield* registry.setEnv(threadId, "stopped");
        const after = yield* infoOf(threadId);
        emitThreadChanged(after);
      });

    const listenersRef = yield* Ref.make<ReadonlySet<HubListener>>(new Set());

    const notify = (event: HubEvent): void => {
      // Listeners are sync callbacks (the server forks its own broadcasts);
      // a throwing listener must not take the hub down.
      const listeners = Effect.runSync(Ref.get(listenersRef));
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (error) {
          console.warn(`[hub] listener failed: ${messageOf(error)}`);
        }
      }
    };

    const emitThreadChanged = (thread: ThreadInfo): void => {
      notify({ type: "thread_changed", thread });
    };

    /** Apply a worker report; broadcast when the wire view changed. */
    const applyReport = (
      threadId: string,
      report: WorkerReport,
    ): Effect.Effect<void, HubError, never> =>
      Effect.gen(function* () {
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
          yield* disarmIdleStop(threadId);
        } else if (report.state === "idle") {
          yield* armIdleStop(threadId);
        }
        const after = yield* registry.toInfo(threadId);
        if (
          Option.isSome(before) &&
          Option.isSome(after) &&
          JSON.stringify(before.value) !== JSON.stringify(after.value)
        ) {
          emitThreadChanged(after.value);
        }
      });

    const events: HubEventSink = {
      sessionEvent: (threadId, event, tailSeq) => {
        void Effect.runFork(
          Effect.gen(function* () {
            yield* registry.setTailSeq(threadId, tailSeq);
            // Any event is activity: reset the idle timer.
            yield* armIdleStop(threadId);
            notify({ type: "session_event", threadId, event });
          }),
        );
      },
      report: (threadId, report) => {
        void Effect.runFork(applyReport(threadId, report));
      },
    };

    const infoOf = (threadId: string): Effect.Effect<ThreadInfo, HubError, never> =>
      Effect.gen(function* () {
        const info = yield* registry.toInfo(threadId);
        if (Option.isNone(info)) {
          return yield* Effect.fail(new HubError({ message: `unknown thread: ${threadId}` }));
        }
        return info.value;
      });

    /** The env gate: a non-ready env is provisioned before the command runs. */
    const ensureEnv = (thread: HubRecord): Effect.Effect<void, HubError, never> =>
      Effect.gen(function* () {
        if (thread.env === "ready") {
          // Activity on a ready env resets the idle timer.
          yield* armIdleStop(thread.id);
          return;
        }
        yield* disarmIdleStop(thread.id);
        const outcome = yield* provisioner
          .ensure(thread, Option.fromNullishOr(thread.envHandle))
          .pipe(Effect.result);
        if (Result.isFailure(outcome)) {
          yield* registry.setEnv(thread.id, "error");
          const info = yield* infoOf(thread.id);
          emitThreadChanged(info);
          return yield* Effect.fail(new HubError({ message: outcome.failure.message }));
        }
        if (Option.isSome(outcome.success)) {
          yield* registry.setEnvHandle(thread.id, outcome.success.value);
        }
        yield* registry.setEnv(thread.id, "ready");
        const info = yield* infoOf(thread.id);
        emitThreadChanged(info);
        // The thread is idle until the command runs: arm the timer now.
        yield* armIdleStop(thread.id);
      });

    return {
      listThreads: () =>
        Effect.gen(function* () {
          const records = yield* registry.list();
          const threads: ThreadInfo[] = [];
          for (const record of records) {
            threads.push(yield* infoOf(record.id));
          }
          return threads;
        }),
      createThread: (input) =>
        Effect.gen(function* () {
          const record = yield* registry.create(input);
          const workerCreated = yield* workerRef.create(record.id, record).pipe(Effect.result);
          if (Result.isFailure(workerCreated)) {
            // Roll back: a thread whose worker cannot exist must not exist.
            yield* registry.delete(record.id);
            return yield* Effect.fail(
              new HubError({
                message: `failed to create worker: ${workerCreated.failure.message}`,
              }),
            );
          }
          const info = yield* infoOf(record.id);
          emitThreadChanged(info);
          return info;
        }),
      getThread: (threadIdInput) =>
        Effect.gen(function* () {
          const threadId = yield* resolveThreadId(registry, threadIdInput);
          return yield* infoOf(threadId);
        }),
      renameThread: (threadIdInput, name) =>
        Effect.gen(function* () {
          const threadId = yield* resolveThreadId(registry, threadIdInput);
          const trimmed = name.trim();
          if (trimmed.length === 0) {
            return yield* Effect.fail(new HubError({ message: "name must not be empty" }));
          }
          // A user rename wins over auto-title forever (CONTEXT.md: Auto-title).
          yield* registry.update(threadId, { name: trimmed, autoName: false });
          const info = yield* infoOf(threadId);
          emitThreadChanged(info);
          return info;
        }),
      deleteThread: (threadIdInput) =>
        Effect.gen(function* () {
          const threadId = yield* resolveThreadId(registry, threadIdInput);
          const info = yield* infoOf(threadId);
          const record = yield* registry.get(threadId);
          // Best-effort teardown: the record is gone either way.
          yield* workerRef.delete(threadId).pipe(Effect.catch(() => Effect.void));
          if (Option.isSome(record)) {
            yield* disarmIdleStop(threadId);
            yield* provisioner
              .release(threadId, Option.fromNullishOr(record.value.envHandle))
              .pipe(Effect.catch(() => Effect.void));
          }
          yield* registry.delete(threadId);
          emitThreadChanged(info);
          return info;
        }),
      runSessionCommand: (threadIdInput, command) =>
        Effect.gen(function* () {
          const threadId = yield* resolveThreadId(registry, threadIdInput);
          const record = yield* registry.get(threadId);
          if (Option.isNone(record)) {
            return yield* Effect.fail(new HubError({ message: `unknown thread: ${threadId}` }));
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
      importSkill: (source, scope) =>
        skills.import({ source, ...(scope === undefined ? {} : { scope }) }),
      deleteSkill: (id) =>
        Effect.gen(function* () {
          const deleted = yield* skills.delete(id);
          if (!deleted) {
            return yield* Effect.fail(new HubError({ message: `unknown skill: ${id}` }));
          }
        }),
      events,
      subscribe: (listener) => {
        const set = Effect.runSync(Ref.get(listenersRef));
        const next = new Set(set);
        next.add(listener);
        void Effect.runFork(Ref.set(listenersRef, next));
        return () => {
          const current = Effect.runSync(Ref.get(listenersRef));
          const without = new Set(current);
          without.delete(listener);
          void Effect.runFork(Ref.set(listenersRef, without));
        };
      },
      close: () =>
        Effect.gen(function* () {
          const timers = yield* Ref.get(idleTimersRef);
          for (const timer of timers.values()) clearTimeout(timer);
          yield* Ref.set(idleTimersRef, new Map());
          yield* workerRef.close().pipe(Effect.catch(() => Effect.void));
        }),
    };
  });
