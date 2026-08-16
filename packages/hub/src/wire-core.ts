/**
 * The hub's wire connection core (wire-core.ts): a thin adapter over the
 * shared transport-free server core of `@saku/wire/server` (hello/version
 * auth, stateless command routing, fan-out), wired to the hub's command
 * handlers and its event fan-out.
 *
 * The core owns no sockets and no server: `runConnection` handles one
 * socket for its lifetime, `close` drops every live connection and
 * unsubscribes from the hub. All semantics live in the `HubApi` it is
 * given — the shared core's `runHubCommand`/`runSessionCommand` slots are
 * the hub's own thread/skills/session handlers.
 */

import type { Scope } from "effect";
import { Context, Effect, Match } from "effect";

import type {
  PiSessionCommand,
  ProjectCommand,
  ResponsePayload,
  SkillCommand,
  ThreadCommand,
  WireEvent,
} from "@saku/wire";
import {
  ArchiveThreadResponse,
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
  UnarchiveThreadResponse,
} from "@saku/wire";
import { WireServer } from "@saku/wire/server";

import { HubError } from "./hub-error.ts";
import type { HubEvent, HubApi } from "./hub.ts";
import type { SocketLike } from "./socket.ts";

export interface WireCoreOptions {
  readonly hub: HubApi;
  /** The deployment secret, presented in `hello` (v1: single-owner auth). */
  readonly token: string;
  /** The pid reported in `hello_ok` (node: process.pid; a DO: 0). */
  readonly pid?: number;
}

export interface WireCoreApi {
  /** Handle one accepted socket for its lifetime (scope closes on close). */
  readonly runConnection: (socket: SocketLike) => Effect.Effect<void, never, Scope.Scope>;
  /** Drop every live connection and unsubscribe from the hub. */
  readonly close: () => Effect.Effect<void>;
}

/** The hub-shaped thread/skill routing (the semantics live in `hub.ts`). */
const runHubCommand =
  (hub: HubApi) => (incoming: ThreadCommand | SkillCommand | PiSessionCommand | ProjectCommand) =>
    Match.value(incoming).pipe(
      Match.withReturnType<Effect.Effect<ResponsePayload, HubError>>(),
      Match.tagsExhaustive({
        // Projects scope the local daemon's pi-session window; the hub has
        // no ~/.pi, so the window (and its scope) is local-daemon-only.
        add_project: () =>
          Effect.fail(
            new HubError({
              kind: "projects",
              message: "projects are served by the local daemon, not the hub",
            }),
          ),
        archive_thread: (command) =>
          hub
            .archiveThread(command.threadId)
            .pipe(Effect.map((thread) => ArchiveThreadResponse.make({ thread }))),
        browse_project_dirs: () =>
          Effect.fail(
            new HubError({
              kind: "projects",
              message: "projects are served by the local daemon, not the hub",
            }),
          ),
        create_thread: (command) => {
          const input: Parameters<HubApi["createThread"]>[0] = { name: command.name };
          if (command.cwd !== undefined) {
            input.cwd = command.cwd;
          }
          if (command.mode !== undefined) {
            input.mode = command.mode;
          }
          if (command.autoName !== undefined) {
            input.autoName = command.autoName;
          }
          return hub
            .createThread(input)
            .pipe(Effect.map((thread) => CreateThreadResponse.make({ thread })));
        },
        delete_skill: (command) =>
          hub.deleteSkill(command.id).pipe(Effect.map(() => DeleteSkillResponse.make({}))),
        delete_thread: (command) =>
          hub.deleteThread(command.threadId).pipe(Effect.map(() => DeleteThreadResponse.make({}))),
        get_thread: (command) =>
          hub
            .getThread(command.threadId)
            .pipe(Effect.map((thread) => GetThreadResponse.make({ thread }))),
        // pi sessions live on the user's machine; only the local daemon
        // serves these (the mirror of the daemon's skills_not_served).
        import_pi_session: () =>
          Effect.fail(
            new HubError({
              kind: "pi_sessions",
              message: "pi sessions are served by the local daemon, not the hub",
            }),
          ),
        import_skill: (command) =>
          hub
            .importSkill(command.source, command.scope)
            .pipe(Effect.map((skill) => ImportSkillResponse.make({ skill }))),
        list_pi_sessions: () =>
          Effect.fail(
            new HubError({
              kind: "pi_sessions",
              message: "pi sessions are served by the local daemon, not the hub",
            }),
          ),
        list_projects: () =>
          Effect.fail(
            new HubError({
              kind: "projects",
              message: "projects are served by the local daemon, not the hub",
            }),
          ),
        list_skills: () =>
          hub.listSkills().pipe(Effect.map((skills) => ListSkillsResponse.make({ skills }))),
        list_threads: () =>
          hub.listThreads().pipe(Effect.map((threads) => ListThreadsResponse.make({ threads }))),
        remove_project: () =>
          Effect.fail(
            new HubError({
              kind: "projects",
              message: "projects are served by the local daemon, not the hub",
            }),
          ),
        rename_thread: (command) =>
          hub
            .renameThread(command.threadId, command.name)
            .pipe(Effect.map((thread) => RenameThreadResponse.make({ thread }))),
        unarchive_thread: (command) =>
          hub
            .unarchiveThread(command.threadId)
            .pipe(Effect.map((thread) => UnarchiveThreadResponse.make({ thread }))),
      }),
    );

/** The core also runs inside a DO (workerd), where Node's `process` global is absent.
 * `globalThis.process` reads don't throw for the missing binding (a bare `process`
 * reference would). */
const isNodeProcess = (value: NodeJS.Process | undefined): value is NodeJS.Process =>
  value !== undefined;

/** The hub's wire connection core: a thin adapter over `WireServer.make`. */
export class WireCore extends Context.Service<WireCore, WireCoreApi>()("WireCore", {
  make: Effect.fn("WireCore.make")(function* make(options: WireCoreOptions) {
    const { hub, token } = options;
    const pid = options.pid ?? (isNodeProcess(globalThis.process) ? globalThis.process.pid : 0);
    const core = yield* WireServer.make({
      handlers: {
        runHubCommand: runHubCommand(hub),
        runSessionCommand: (threadId, command) => hub.runSessionCommand(threadId, command),
      },
      log: (message) => Effect.logWarning(`[saku-hub] ${message}`),
      pid,
      token: () => Effect.succeed(token),
    });

    /** The hub's events → wire frames (the fan-out). */
    const onHubEvent = (event: HubEvent) => {
      const frame: WireEvent =
        event._tag === "thread_changed"
          ? ThreadChanged.make({ thread: event.thread })
          : EventFrame.make({ event: event.event, threadId: event.threadId });
      void Effect.runFork(core.broadcast(frame));
    };

    // The hub subscription lives for the core's lifetime (the node server
    // closes it on teardown; a DO keeps it for the instance's lifetime).
    const unsubscribe = hub.subscribe(onHubEvent);

    return {
      close: Effect.fn(function* close() {
        unsubscribe();
        yield* core.close();
      }),
      runConnection: (socket) => core.runConnection(socket),
    } satisfies WireCoreApi;
  }),
}) {}
