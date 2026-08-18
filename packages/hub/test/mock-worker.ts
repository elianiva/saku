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

import { Effect, Match } from "effect";
import {
  GetAvailableModelsResponse,
  GetAvailableThinkingLevelsResponse,
  GetEntriesResponse,
  GetStateResponse,
  THINKING_LEVELS,
} from "@saku/wire";
import type { SessionCommand, SessionWireEvent } from "@saku/wire";

import type { EnvHandle } from "@saku/env";
import { HubError } from "../src/hub-error.ts";
import type {
  EnvProvisioner,
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
export const scriptedProvisioner = (
  options: { fail?: boolean } = {},
): EnvProvisioner & {
  readonly released: string[];
} => {
  const released: string[] = [];
  return {
    ensure: (thread, remoteMachineId, handle) => {
      if (thread.mode !== "sandbox") {
        return Effect.succeed({ handle: null, remoteMachineId: null });
      }
      if (options.fail === true) {
        return Effect.fail(
          new HubError({ kind: "provisioner", message: "sandbox provisioning failed (scripted)" }),
        );
      }
      const existing: EnvHandle = handle ?? {
        token: "env-token",
        url: "ws://127.0.0.1:1",
      };
      return Effect.succeed({
        handle: existing,
        remoteMachineId: remoteMachineId ?? "machine_scripted",
      });
    },
    release: (threadId) =>
      Effect.sync(() => {
        released.push(threadId);
      }),
    released,
  };
};

/** The single model the scripted worker's catalog knows (wire test's twin). */
export const MOCK_MODEL = { contextWindow: 128_000, id: "m1", provider: "mock", reasoning: true };

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
    fn: (threadId: string, command: SessionCommand) => Effect.Effect<WorkerCommandResult, HubError>,
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
const canned = (_threadId: string, command: SessionCommand) =>
  Match.value(command).pipe(
    Match.withReturnType<Effect.Effect<WorkerCommandResult, HubError>>(),
    Match.tags({
      get_available_models: () =>
        Effect.succeed({
          payload: GetAvailableModelsResponse.make({ models: [MOCK_MODEL] }),
          tailSeq: 0,
        }),
      get_available_thinking_levels: () =>
        Effect.succeed({
          payload: GetAvailableThinkingLevelsResponse.make({ levels: [...THINKING_LEVELS] }),
          tailSeq: 0,
        }),
      get_entries: () =>
        Effect.succeed({
          payload: GetEntriesResponse.make({ entries: [], leafId: null, tailSeq: 0 }),
          tailSeq: 0,
        }),
      get_state: () =>
        Effect.succeed({
          payload: GetStateResponse.make({
            state: {
              model: null,
              sessionId: null,
              state: "idle",
              tailSeq: 0,
              thinkingLevel: "off",
            },
          }),
          tailSeq: 0,
        }),
    }),
    Match.orElse((other) =>
      Effect.fail(new HubError({ kind: "command", message: `unscripted command: ${other._tag}` })),
    ),
  );

export const scriptedWorker = (): ScriptedWorker => {
  const created: string[] = [];
  const deleted: string[] = [];
  const commands: ScriptedCommand[] = [];
  let handler: (
    threadId: string,
    command: SessionCommand,
  ) => Effect.Effect<WorkerCommandResult, HubError> = canned;
  let sink: HubEventSink | undefined;
  let createError: HubError | undefined;

  const ref: ThreadWorkerRef = {
    close: () => Effect.void,
    command: Effect.fn("command")(function* (threadId, command) {
      commands.push({ command, threadId });
      return yield* handler(threadId, command);
    }),
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
  };

  return {
    attach: (attached) => {
      sink = attached;
    },
    commands,
    created,
    deleted,
    emit: (threadId, event, tailSeq) => sink?.sessionEvent(threadId, event, tailSeq ?? 0),
    failCreateWith: (error) => {
      createError = error;
    },
    onCommand: (fn) => {
      handler = fn;
    },
    ref,
    report: (threadId, patch) => sink?.report(threadId, patch),
  };
};
