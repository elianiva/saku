/**
 * ScriptedWorker (mock-worker.ts): a scripted `ThreadWorkerRef` for hub
 * tests — records every lifecycle call and routed command, answers the
 * read-only commands with canned values, and lets tests inject worker
 * events and reports through the hub's `HubEventSink` (the worker → hub
 * push channel) exactly the way a real worker would.
 *
 * The real-SessionHost adapter (in-process-worker.ts) covers the other
 * half: this fixture keeps hub tests deterministic and socket-free.
 */

import { Effect, Option } from "effect";
import {
  GetAvailableModelsResponse,
  GetAvailableThinkingLevelsResponse,
  GetEntriesResponse,
  GetStateResponse,
  THINKING_LEVELS,
  type ResponsePayload,
  type SessionCommand,
  type SessionWireEvent,
  type ThreadState,
} from "@saku/wire";

import type { EnvHandle } from "@saku/env";
import { HubError, type EnvProvisioner } from "../src/index.ts";
import type {
  HubEventSink,
  ThreadWorkerRef,
  WorkerCommandResult,
  WorkerReport,
} from "../src/index.ts";

/**
 * A scripted provisioner for hub tests: local threads are always ready
 * (no handle), sandbox threads succeed with a canned handle (or fail,
 * when `fail` is set). `released` records every release call.
 */
export const scriptedProvisioner = (options: { fail?: boolean } = {}): EnvProvisioner & {
  readonly released: string[];
} => {
  const released: string[] = [];
  return {
    ensure: (thread, handle) => {
      if (thread.mode !== "sandbox") return Effect.succeed(Option.none());
      if (options.fail === true) {
        return Effect.fail(new HubError({ message: "sandbox provisioning failed (scripted)" }));
      }
      const existing: EnvHandle =
        Option.isSome(handle)
          ? handle.value
          : { url: "ws://127.0.0.1:1", token: "env-token", boxId: "bx_scripted" };
      return Effect.succeed(Option.some(existing));
    },
    release: (threadId) =>
      Effect.sync(() => {
        released.push(threadId);
      }),
    released,
  };
};

/** The single model the scripted worker's catalog knows (wire test's twin). */
export const MOCK_MODEL = { provider: "mock", id: "m1", contextWindow: 128_000, reasoning: true };

export interface ScriptedCommand {
  readonly threadId: string;
  readonly command: SessionCommand;
}

export interface ScriptedWorker {
  readonly ref: ThreadWorkerRef;
  readonly created: string[];
  readonly deleted: string[];
  readonly commands: ScriptedCommand[];
  /** Scripted command handler; defaults to the canned read-only answers. */
  readonly onCommand: (
    fn: (
      threadId: string,
      command: SessionCommand,
    ) => Effect.Effect<WorkerCommandResult, HubError, never>,
  ) => void;
  /** Make `create` fail with the given error (worker-lifecycle failures). */
  readonly failCreateWith: (error: HubError) => void;
  /** Attach the hub's push channel (the hub is built after the ref). */
  readonly attach: (sink: HubEventSink) => void;
  /** Emit a session event as the worker (with the thread's tailSeq). */
  readonly emit: (threadId: string, event: SessionWireEvent, tailSeq?: number) => void;
  /** Report a registry-visible change as the worker. */
  readonly report: (threadId: string, patch: WorkerReport) => void;
}

/** The canned read-only answers the scripted worker gives until scripted over. */
const canned = (
  _threadId: string,
  command: SessionCommand,
): Effect.Effect<WorkerCommandResult, HubError, never> => {
  switch (command._tag) {
    case "get_entries":
      return Effect.succeed({
        payload: GetEntriesResponse.make({ entries: [], tailSeq: 0, leafId: null }),
        tailSeq: 0,
      });
    case "get_state":
      return Effect.succeed({
        payload: GetStateResponse.make({
          state: { sessionId: null, state: "idle", tailSeq: 0, model: null, thinkingLevel: "off" },
        }),
        tailSeq: 0,
      });
    case "get_available_models":
      return Effect.succeed({
        payload: GetAvailableModelsResponse.make({ models: [MOCK_MODEL] }),
        tailSeq: 0,
      });
    case "get_available_thinking_levels":
      return Effect.succeed({
        payload: GetAvailableThinkingLevelsResponse.make({ levels: [...THINKING_LEVELS] }),
        tailSeq: 0,
      });
    default:
      return Effect.fail(new HubError({ message: `unscripted command: ${command._tag}` }));
  }
};

export const scriptedWorker = (): ScriptedWorker => {
  const created: string[] = [];
  const deleted: string[] = [];
  const commands: ScriptedCommand[] = [];
  let handler: (
    threadId: string,
    command: SessionCommand,
  ) => Effect.Effect<WorkerCommandResult, HubError, never> = canned;
  let sink: HubEventSink | undefined;
  let createError: HubError | undefined;

  const ref: ThreadWorkerRef = {
    create: (threadId) =>
      createError === undefined
        ? Effect.sync(() => {
            created.push(threadId);
          })
        : Effect.fail(createError),
    delete: (threadId) =>
      Effect.sync(() => {
        deleted.push(threadId);
      }),
    setEnvHandle: () => Effect.void,
    command: (threadId, command) =>
      Effect.gen(function* () {
        commands.push({ threadId, command });
        return yield* handler(threadId, command);
      }),
    close: () => Effect.void,
  };

  return {
    ref,
    created,
    deleted,
    commands,
    onCommand: (fn) => {
      handler = fn;
    },
    failCreateWith: (error) => {
      createError = error;
    },
    attach: (attached) => {
      sink = attached;
    },
    emit: (threadId, event, tailSeq) => sink?.sessionEvent(threadId, event, tailSeq ?? 0),
    report: (threadId, patch) => sink?.report(threadId, patch),
  };
};
