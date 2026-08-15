/**
 * The hub's wire connection core (wire-core.ts): a thin adapter over the
 * shared transport-free server core of `@saku/wire/server` (hello/version
 * auth, stateless command routing, fan-out), wired to the hub's command
 * handlers and its event fan-out.
 *
 * The core owns no sockets and no server: `runConnection` handles one
 * socket for its lifetime, `close` drops every live connection and
 * unsubscribes from the hub. All semantics live in the `HubShape` it is
 * given — the shared core's `runHubCommand`/`runSessionCommand` slots are
 * the hub's own thread/skills/session handlers.
 */

import { Context, Effect, Match, Scope } from "effect";

import {
  CreateThreadResponse,
  DeleteSkillResponse,
  DeleteThreadResponse,
  EventFrame,
  GetThreadResponse,
  ImportSkillResponse,
  ListSkillsResponse,
  ListThreadsResponse,
  RenameThreadResponse,
  ThreadChanged,
  type PiSessionCommand,
  type ResponsePayload,
  type SkillCommand,
  type ThreadCommand,
  type WireEvent,
} from "@saku/wire";
import { WireServer } from "@saku/wire/server";

import { HubError } from "./hub-error.ts";
import type { HubEvent, HubShape } from "./hub.ts";
import type { SocketLike } from "./socket.ts";

export interface WireCoreOptions {
  readonly hub: HubShape;
  /** The deployment secret, presented in `hello` (v1: single-owner auth). */
  readonly token: string;
  /** The pid reported in `hello_ok` (node: process.pid; a DO: 0). */
  readonly pid?: number;
}

export interface WireCoreShape {
  /** Handle one accepted socket for its lifetime (scope closes on close). */
  readonly runConnection: (socket: SocketLike) => Effect.Effect<void, never, Scope.Scope>;
  /** Drop every live connection and unsubscribe from the hub. */
  readonly close: () => Effect.Effect<void, never>;
}

/** The hub-shaped thread/skill routing (the semantics live in `hub.ts`). */
const runHubCommand =
  (hub: HubShape) => (command: ThreadCommand | SkillCommand | PiSessionCommand) =>
    Match.value(command).pipe(
      Match.withReturnType<Effect.Effect<ResponsePayload, HubError, never>>(),
      Match.tagsExhaustive({
        list_threads: () =>
          hub.listThreads().pipe(Effect.map((threads) => ListThreadsResponse.make({ threads }))),
        create_thread: (command) =>
          hub
            .createThread({
              name: command.name,
              ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
              ...(command.mode === undefined ? {} : { mode: command.mode }),
              ...(command.autoName === undefined ? {} : { autoName: command.autoName }),
            })
            .pipe(Effect.map((thread) => CreateThreadResponse.make({ thread }))),
        get_thread: (command) =>
          hub
            .getThread(command.threadId)
            .pipe(Effect.map((thread) => GetThreadResponse.make({ thread }))),
        rename_thread: (command) =>
          hub
            .renameThread(command.threadId, command.name)
            .pipe(Effect.map((thread) => RenameThreadResponse.make({ thread }))),
        delete_thread: (command) =>
          hub.deleteThread(command.threadId).pipe(Effect.map(() => DeleteThreadResponse.make({}))),
        list_skills: () =>
          hub.listSkills().pipe(Effect.map((skills) => ListSkillsResponse.make({ skills }))),
        import_skill: (command) =>
          hub
            .importSkill(command.source, command.scope)
            .pipe(Effect.map((skill) => ImportSkillResponse.make({ skill }))),
        delete_skill: (command) =>
          hub.deleteSkill(command.id).pipe(Effect.map(() => DeleteSkillResponse.make({}))),
        // pi sessions live on the user's machine; only the local daemon
        // serves these (the mirror of the daemon's skills_not_served).
        list_pi_sessions: () =>
          Effect.fail(
            new HubError({
              kind: "pi_sessions",
              message: "pi sessions are served by the local daemon, not the hub",
            }),
          ),
        import_pi_session: () =>
          Effect.fail(
            new HubError({
              kind: "pi_sessions",
              message: "pi sessions are served by the local daemon, not the hub",
            }),
          ),
      }),
    );

/** The hub's wire connection core: a thin adapter over `WireServer.make`. */
export class WireCore extends Context.Service<WireCore, WireCoreShape>()("WireCore", {
  make: Effect.fn("WireCore.make")(function* (options: WireCoreOptions) {
    const { hub, token } = options;
    const pid = options.pid ?? (typeof process !== "undefined" ? process.pid : 0);
    const core = yield* WireServer.make({
      token: () => Effect.succeed(token),
      pid,
      log: (message) => Effect.logWarning(`[saku-hub] ${message}`),
      handlers: {
        runHubCommand: runHubCommand(hub),
        runSessionCommand: (threadId, command) => hub.runSessionCommand(threadId, command),
      },
    });

    /** The hub's events → wire frames (the fan-out). */
    const onHubEvent = (event: HubEvent) => {
      const frame: WireEvent =
        event._tag === "thread_changed"
          ? ThreadChanged.make({ thread: event.thread })
          : EventFrame.make({ threadId: event.threadId, event: event.event });
      void Effect.runFork(core.broadcast(frame));
    };

    // The hub subscription lives for the core's lifetime (the node server
    // closes it on teardown; a DO keeps it for the instance's lifetime).
    const unsubscribe = hub.subscribe(onHubEvent);

    return {
      runConnection: (socket) => core.runConnection(socket),
      close: Effect.fn(function* () {
        unsubscribe();
        yield* core.close();
      }),
    } satisfies WireCoreShape;
  }),
}) {}
