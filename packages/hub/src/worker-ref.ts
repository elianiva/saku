/**
 * The worker seam (worker-ref.ts): the hub's only interface to the
 * per-thread workers (ADR 0001).
 *
 * The hub routes every session command to the thread's worker and learns
 * everything it knows about the thread's session through the worker's
 * reports and events:
 *
 * - `command(threadId, command)` → the wire response payload plus the
 *   worker's current durable-log sequence (the registry's `tailSeq` cache)
 * - `create` / `delete` — the thread-DO lifecycle (a DO is created on
 *   `create_thread`; `delete_thread` removes the worker's storage and
 *   alarms — the DO instance itself lingers as a husk, ADR 0001)
 * - `events.sessionEvent` / `events.report` — the worker → hub push channel
 *   (in-process: callbacks; production: the worker DO calls the hub back)
 *
 * Implementations: a scripted ref in hub tests, an in-process ref wrapping
 * the real `SessionHost` in hub tests, and the thread-DO namespace binding
 * when the alchemy deployment lands (M4).
 */

import type { Effect } from "effect";
import type { ResponsePayload, SessionCommand, SessionWireEvent, ThreadState } from "@saku/wire";
import type { EnvHandle } from "@saku/env";

import type { HubError } from "./hub-error.ts";
import type { HubRecord } from "./registry.ts";

/** The outcome of one forwarded session command. */
export interface WorkerCommandResult {
  readonly payload: ResponsePayload;
  /** The worker's durable-log sequence after the command (registry cache). */
  readonly tailSeq: number;
}

/** What a worker can report about its thread (thread_changed inputs). */
export interface WorkerReport {
  readonly state?: ThreadState;
  readonly sessionId?: string | null;
  /** Auto-title result; the hub applies it only while the name is auto-generated. */
  readonly name?: string;
  readonly tailSeq?: number;
}

/** The worker → hub push channel; implementations call these callbacks. */
export interface HubEventSink {
  /** One projected wire event for the thread, with the current tailSeq. */
  readonly sessionEvent: (threadId: string, event: SessionWireEvent, tailSeq: number) => void;
  /** A registry-visible change (state, sessionId, auto-title, tailSeq). */
  readonly report: (threadId: string, report: WorkerReport) => void;
}

export interface ThreadWorkerRef {
  /** Create the worker for a thread (called on `create_thread`). */
  readonly create: (threadId: string, record: HubRecord) => Effect.Effect<void, HubError>;
  /** Delete the worker (called on `delete_thread`): storage, alarms, env. */
  readonly delete: (threadId: string) => Effect.Effect<void, HubError>;
  /**
   * Push the thread's env handle to the worker (after provisioning, on
   * release with null). The worker rebuilds its env connection from it.
   */
  readonly setEnvHandle: (
    threadId: string,
    handle: EnvHandle | null,
  ) => Effect.Effect<void, HubError>;
  /** Forward one session command to the thread's worker. */
  readonly command: (
    threadId: string,
    command: SessionCommand,
  ) => Effect.Effect<WorkerCommandResult, HubError>;
  /** Shut the ref down (drop hosts, close the namespace handle). Best-effort. */
  readonly close: () => Effect.Effect<void, HubError>;
}
