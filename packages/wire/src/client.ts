/**
 * The wire's client feature: a console's connection to the hub (or,
 * transitionally, the local daemon). Comparable to pi's `RpcClient`, but
 * WebSocket-based and thread-scoped.
 *
 * The client is an `effect-machine` actor: the connection lifecycle
 * (disconnected → connecting → handshaking → connected) is a schema-first
 * state machine, and every socket event is an input to it. Commands are
 * Effects correlated by request id (pending requests are `Deferred`s in a
 * `Ref`, resolved by the machine when the response frame arrives).
 *
 * - typed callback subscriptions for streamed events (foldkit-friendly)
 * - optional reconnect with exponential backoff; on reconnect the console
 *   catches up via `get_entries(since tailSeq)` (no server-side replay)
 *
 * The client speaks the WHATWG `WebSocket` (global in browsers and Node ≥ 22)
 * — the same code runs in the frontend and the CLI.
 *
 * `WireClient.make` spawns the actor and returns the client value;
 * `connect` completes the handshake and returns the server's `HelloOk`;
 * `disconnect` fails pending requests, closes the socket, and drains the
 * actor.
 */

import {
  Cause,
  Context,
  Deferred,
  Effect,
  Match,
  Option,
  Ref,
  Result,
  Schedule,
  Schema,
} from "effect";
import { Event, Machine, State } from "effect-machine";
import type {
  CompactResult,
  Entry,
  SessionStats,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";

import type { ConsoleRole, HelloOk } from "./hello.ts";
import { Hello } from "./hello.ts";
import type { WireCommand } from "./envelope.ts";
import { WireEvent } from "./envelope.ts";
import { decodeFrame, isSocketMessage, parseFrame, serializeFrame } from "./transport.ts";
import type { ThreadCommand, ThreadInfo, ThreadMode } from "./thread.ts";
import {
  ArchiveThreadCommand,
  CreateThreadCommand,
  DeleteThreadCommand,
  GetThreadCommand,
  ListThreadsCommand,
  RenameThreadCommand,
  UnarchiveThreadCommand,
} from "./thread.ts";
import type {
  ResponsePayload,
  SessionCommand,
  SessionResponse,
  SessionWireEvent,
  ThreadSessionState,
  WireModelInfo,
} from "./session.ts";
import {
  AbortCommand,
  BranchCommand,
  CompactCommand,
  FollowUpCommand,
  GetAvailableModelsCommand,
  GetAvailableThinkingLevelsCommand,
  GetEntriesCommand,
  GetSessionStatsCommand,
  GetStateCommand,
  PromptCommand,
  SetAutoCompactionCommand,
  SetFollowUpModeCommand,
  SetModelCommand,
  SetSessionNameCommand,
  SetSteeringModeCommand,
  SetThinkingLevelCommand,
  SteerCommand,
} from "./session.ts";
import type { SkillCommand, SkillInfo, SkillScope } from "./skills.ts";
import { DeleteSkillCommand, ImportSkillCommand, ListSkillsCommand } from "./skills.ts";
import type { PiSessionCommand, PiSessionInfo } from "./pi-sessions.ts";
import { ImportPiSessionCommand, ListPiSessionsCommand } from "./pi-sessions.ts";
import type { BrowseProjectDirsResult, ProjectCommand, ProjectInfo } from "./projects.ts";
import {
  AddProjectCommand,
  BrowseProjectDirsCommand,
  ListProjectsCommand,
  RemoveProjectCommand,
} from "./projects.ts";
import { opaque } from "./opaque.ts";
import { WireError } from "./wire-error.ts";
import { WIRE_VERSION } from "./version.ts";

export interface WorkerClientOptions {
  /** The hub's wire endpoint: `ws://` or `wss://` URL. */
  readonly url: string;
  /** The deployment secret, presented in `hello`. */
  readonly token: string;
  readonly role: ConsoleRole;
  /** The client's wire version; defaults to WIRE_VERSION. Overridable for tests. */
  readonly version?: string;
  /** Reconnect with backoff after unexpected disconnects. Default: false. */
  readonly reconnect?: boolean;
  /** Per-command timeout. Default: 30s (pi's RpcClient habit). */
  readonly requestTimeoutMs?: number;
}

/** Payloads of the wire events a console can subscribe to. */
export interface ClientEvents {
  /** A streamed session event for a thread. */
  readonly event: { readonly threadId: string; readonly event: SessionWireEvent };
  /** Registry mutation broadcast. */
  readonly thread_changed: ThreadInfo;
  /** Handshake reply (fires on every connect). */
  readonly hello_ok: HelloOk;
  /** Connection-level failure (malformed input, server error). */
  readonly error: { readonly message: string };
  /** The connection closed. */
  readonly close: undefined;
}
export type ClientEventKind = keyof ClientEvents;

/** Connection lifecycle. The socket rides the state it belongs to. */
const ClientState = State({
  /** Handshake done; commands flow. */
  Connected: { socket: Schema.instanceOf(WebSocket) },
  /** The socket is being created/opened. */
  Connecting: {},
  Disconnected: {},
  /** Socket open; `hello` sent, awaiting `hello_ok`. */
  Handshaking: { socket: Schema.instanceOf(WebSocket) },
});

/** Everything the machine reacts to: API calls and socket events. */
const ClientEvent = Event({
  /** The socket closed. */
  Closed: {},
  /** A wire command the API layer already correlated (id + frame). */
  CommandSent: { frame: opaque<WireCommand>(), id: Schema.String },
  ConnectRequested: {},
  DisconnectRequested: {},
  /** The socket errored (connection refused, DNS failure). */
  Errored: {},
  /** One raw JSON line from the server. */
  Frame: { line: Schema.String },
  /** The socket opened; carries the socket into the handshake. */
  Opened: { socket: Schema.instanceOf(WebSocket) },
});

/** Correlate a request id with the deferred that awaits its response. */
type Pending = ReadonlyMap<string, Deferred.Deferred<ResponsePayload, WireError>>;

/** The in-flight handshake's deferred; None when no connect is pending. */
type ConnectDeferred = Deferred.Deferred<HelloOk, WireError>;

/**
 * Sync subscription registry: one listener set per event kind, typed per
 * kind (framework boundary).
 */
type ListenerRegistry = {
  readonly [K in ClientEventKind]: Set<(payload: ClientEvents[K]) => void>;
};

interface ClientDeps {
  readonly url: string;
  readonly token: string;
  readonly role: ConsoleRole;
  readonly version: string;
  readonly pendingRef: Ref.Ref<Pending>;
  readonly connectRef: Ref.Ref<Option.Option<ConnectDeferred>>;
  readonly listeners: ListenerRegistry;
}

/** Whether a decoded response payload is the variant its command carries. */
const isResponseVariant = <K extends ResponsePayload["_tag"]>(
  payload: ResponsePayload,
  tag: K,
): payload is SessionResponse<K> => payload._tag === tag;

/** Settle the pending handshake with an outcome; a stale ref is a no-op. */
const settleConnect = (deps: ClientDeps, outcome: Result.Result<HelloOk, WireError>) =>
  Ref.getAndSet(deps.connectRef, Option.none()).pipe(
    Effect.flatMap((pending) =>
      Option.match(pending, {
        onNone: () => Effect.void,
        onSome: (deferred) =>
          Result.match(outcome, {
            // The settle result is discarded (the boolean is the settle
            // success) — align both arms on void so inference stays stable
            // across programs (`Deferred` returns `Effect<boolean>`).
            onFailure: (error) => Deferred.fail(deferred, error).pipe(Effect.asVoid),
            onSuccess: (hello) => Deferred.succeed(deferred, hello).pipe(Effect.asVoid),
          }),
      }),
    ),
  );

const emit = Effect.fn("emit")(function* <K extends ClientEventKind>(
  deps: ClientDeps,
  kind: K,
  payload: ClientEvents[K],
) {
  const set = deps.listeners[kind];
  for (const listener of set) {
    const result = Result.try(() => {
      listener(payload);
    });
    if (Result.isFailure(result)) {
      yield* Effect.logError("[wire] listener failed:", result.failure);
    }
  }
});

/** Fail every in-flight request; the pending map is drained. */
const failAllPending = (deps: ClientDeps, error: WireError) =>
  Ref.getAndSet(deps.pendingRef, new Map()).pipe(
    Effect.flatMap((pending) =>
      Effect.forEach(pending, ([, deferred]) => Deferred.fail(deferred, error), { discard: true }),
    ),
  );

/** Resolve a correlated request; a late/abandoned id is a no-op. */
const resolveResponse = (
  deps: ClientDeps,
  id: string,
  outcome: Result.Result<ResponsePayload, WireError>,
) =>
  Ref.getAndUpdate(deps.pendingRef, (pending) => {
    const next = new Map(pending);
    next.delete(id);
    return next;
  }).pipe(
    Effect.flatMap((pending) => {
      const deferred = pending.get(id);
      if (deferred === undefined) {
        return Effect.void;
      }
      return Result.match(outcome, {
        onFailure: (error) => Deferred.fail(deferred, error),
        onSuccess: (payload) => Deferred.succeed(deferred, payload),
      });
    }),
  );

/** Dispatch one decoded server frame in `Connected`. */
const handleFrame = Effect.fn("handleFrame")(function* (deps: ClientDeps, frame: WireEvent) {
  yield* Match.value(frame).pipe(
    Match.withReturnType<Effect.Effect<void>>(),
    Match.tagsExhaustive({
      error: (errorFrame) => emit(deps, "error", { message: errorFrame.message }),
      event: (eventFrame) =>
        // The envelope's event payload is opaque JSON by design (ADR 0005:
        // pi's event vocabulary crosses the wire unvalidated); the console
        // narrows it to the projected `SessionWireEvent` at this boundary.
        emit(deps, "event", {
          event: Effect.runSync(
            Schema.decodeUnknownEffect(opaque<SessionWireEvent>())(eventFrame.event),
          ),
          threadId: eventFrame.threadId,
        }),
      hello_ok: (helloFrame) => emit(deps, "hello_ok", helloFrame),
      response: (responseFrame) =>
        responseFrame.ok
          ? resolveResponse(deps, responseFrame.id, Result.succeed(responseFrame.payload))
          : resolveResponse(
              deps,
              responseFrame.id,
              Result.fail(new WireError({ code: "command_failed", message: responseFrame.error })),
            ),
      thread_changed: (threadFrame) => emit(deps, "thread_changed", threadFrame.thread),
    }),
  );
});

/** Decode one frame line, or surface the failure as an error event. */
const decodeFrameLine = Effect.fn("decodeFrameLine")(function* (deps: ClientDeps, line: string) {
  const parsed = Result.try(() => parseFrame(line));
  if (Result.isFailure(parsed)) {
    yield* emit(deps, "error", { message: "malformed JSON frame from server" });
    return yield* Effect.fail(new WireError({ code: "decode", message: "malformed frame" }));
  }
  const decoded = yield* Schema.decodeUnknownEffect(WireEvent)(parsed.success).pipe(Effect.result);
  if (Result.isFailure(decoded)) {
    yield* emit(deps, "error", { message: `undecodable wire frame: ${String(decoded.failure)}` });
    return yield* Effect.fail(new WireError({ code: "decode", message: "undecodable frame" }));
  }
  return decoded.success;
});

/**
 * The connection machine. Transitions are total: a decode failure or a
 * closed socket becomes an error event or a failed deferred, never a
 * defect. Socket listeners are wired by the `Connecting` spawn effect and
 * cast their events into the actor.
 */

/** The close event's payload: the connection carries nothing on close. */
const CLOSE_PAYLOAD = undefined;

const makeMachine = (deps: ClientDeps) =>
  Machine.make({
    event: ClientEvent,
    initial: ClientState.Disconnected,
    state: ClientState,
  })
    .on(ClientState.Disconnected, ClientEvent.ConnectRequested, () => ClientState.Connecting)
    // The socket is created and wired on entry to Connecting; the open
    // event carries it into the handshake. The listeners fire through
    // Handshaking and Connected, so they outlive the state scope.
    .spawn(ClientState.Connecting, ({ self }) =>
      Effect.sync(() => {
        const socket = new WebSocket(deps.url);
        socket.binaryType = "arraybuffer";
        socket.addEventListener("open", () => {
          void Effect.runFork(self.send(ClientEvent.Opened({ socket })));
        });
        socket.addEventListener("message", (message) => {
          // binaryType is "arraybuffer", so messages arrive as strings or
          // ArrayBuffers; anything else is dropped here (the transport
          // would reject it).
          const data: unknown = message.data;
          if (isSocketMessage(data)) {
            const line = Result.try(() => decodeFrame(data));
            if (Result.isSuccess(line)) {
              void Effect.runFork(self.send(ClientEvent.Frame({ line: line.success })));
            }
          }
        });
        socket.addEventListener("close", () => {
          void Effect.runFork(self.send(ClientEvent.Closed));
        });
        socket.addEventListener("error", () => {
          // The WHATWG error event carries no code; during Connecting it
          // means the endpoint did not answer.
          void Effect.runFork(self.send(ClientEvent.Errored));
        });
      }),
    )
    .on(ClientState.Connecting, ClientEvent.Opened, ({ event }) =>
      Effect.gen(function* () {
        const sent = Result.try(() => {
          event.socket.send(
            serializeFrame(
              Hello.make({ role: deps.role, token: deps.token, version: deps.version }),
            ),
          );
        });
        if (Result.isFailure(sent)) {
          yield* settleConnect(
            deps,
            Result.fail(
              new WireError({ code: "disconnected", message: "socket closed before hello" }),
            ),
          );
          return ClientState.Disconnected;
        }
        return ClientState.Handshaking({ socket: event.socket });
      }),
    )
    .on(ClientState.Connecting, ClientEvent.Errored, () =>
      Effect.gen(function* () {
        yield* settleConnect(
          deps,
          Result.fail(
            new WireError({ code: "refused", message: "connection to the server failed" }),
          ),
        );
        // The close event follows and moves the machine to Disconnected.
        return ClientState.Connecting;
      }),
    )
    .on(ClientState.Connecting, ClientEvent.Closed, () =>
      Effect.gen(function* () {
        yield* settleConnect(
          deps,
          Result.fail(
            new WireError({ code: "disconnected", message: "connection closed before open" }),
          ),
        );
        return ClientState.Disconnected;
      }),
    )
    .on(ClientState.Handshaking, ClientEvent.Frame, ({ state, event }) =>
      Effect.gen(function* () {
        const decoded = yield* decodeFrameLine(deps, event.line).pipe(Effect.option);
        if (Option.isNone(decoded)) {
          // Malformed; the error event was emitted.
          return state;
        }
        if (decoded.value._tag === "hello_ok") {
          yield* settleConnect(deps, Result.succeed(decoded.value));
          yield* emit(deps, "hello_ok", decoded.value);
          return ClientState.Connected({ socket: state.socket });
        }
        if (decoded.value._tag === "error") {
          yield* settleConnect(
            deps,
            Result.fail(new WireError({ code: "handshake", message: decoded.value.message })),
          );
          return ClientState.Disconnected;
        }
        // Not the handshake reply; keep reading.
        return state;
      }),
    )
    .on(ClientState.Handshaking, ClientEvent.Closed, () =>
      Effect.gen(function* () {
        yield* settleConnect(
          deps,
          Result.fail(
            new WireError({ code: "disconnected", message: "connection closed during handshake" }),
          ),
        );
        return ClientState.Disconnected;
      }),
    )
    .on(ClientState.Connected, ClientEvent.Frame, ({ state, event }) =>
      Effect.gen(function* () {
        const decoded = yield* decodeFrameLine(deps, event.line).pipe(Effect.option);
        if (Option.isSome(decoded)) {
          yield* handleFrame(deps, decoded.value);
        }
        return state;
      }),
    )
    .on(ClientState.Connected, ClientEvent.Closed, () =>
      Effect.gen(function* () {
        yield* failAllPending(
          deps,
          new WireError({ code: "disconnected", message: "connection closed" }),
        );
        yield* emit(deps, "close", CLOSE_PAYLOAD);
        return ClientState.Disconnected;
      }),
    )
    .on(ClientState.Connected, ClientEvent.CommandSent, ({ state, event }) =>
      Effect.gen(function* () {
        const sent = Result.try(() => {
          state.socket.send(serializeFrame(event.frame));
        });
        if (Result.isFailure(sent)) {
          yield* resolveResponse(
            deps,
            event.id,
            Result.fail(new WireError({ code: "disconnected", message: "socket closed" })),
          );
        }
        return state;
      }),
    )
    .onAny(ClientEvent.DisconnectRequested, ({ state }) =>
      Effect.gen(function* () {
        yield* settleConnect(
          deps,
          Result.fail(new WireError({ code: "disconnected", message: "client disconnected" })),
        );
        if (state._tag === "Connected" || state._tag === "Handshaking") {
          yield* Effect.sync(() => {
            state.socket.close();
          });
        }
        return ClientState.Disconnected;
      }),
    );

// The command registry: one row per wire command (its schema/make, thread
// scoping, response extractor). Every client method below is derived from
// its row, so the request shape and the response extraction live in one
// place per command.

interface CommandSpec<A extends object, K extends ResponsePayload["_tag"], T> {
  /** The command's schema; its static `make` builds the wire payload. */
  readonly schema: {
    readonly make: (
      args: A,
    ) => SessionCommand | ThreadCommand | SkillCommand | PiSessionCommand | ProjectCommand;
  };
  /** Session commands ride the frame's threadId; hub-level commands don't. */
  readonly threadScoped: boolean;
  /** The response variant this command's reply carries. */
  readonly tag: K;
  /** Extract the method's return value from the response payload. */
  readonly extract: (payload: SessionResponse<K>) => T;
}

/** One registry row: the command's schema, its scoping, and its extractor. */
const command = <A extends object, K extends ResponsePayload["_tag"], T>(
  threadScoped: boolean,
  tag: K,
  schema: {
    readonly make: (
      args: A,
    ) => SessionCommand | ThreadCommand | SkillCommand | PiSessionCommand | ProjectCommand;
  },
  extract: (payload: SessionResponse<K>) => T,
) => ({ extract, schema, tag, threadScoped });

/** The extractor for commands whose response carries no result. */
const noResult = (): undefined => undefined;

/** One correlated command frame, with its threadId when session-scoped. */
const commandFrame = (
  id: string,
  payload: SessionCommand | ThreadCommand | SkillCommand | PiSessionCommand | ProjectCommand,
  threadId: string | undefined,
): WireCommand =>
  threadId === undefined
    ? { _tag: "command", command: payload, id }
    : { _tag: "command", command: payload, id, threadId };

/** One row per wire command; the client methods are thin derivations. */
const COMMANDS = {
  abort: command(true, "abort", AbortCommand, noResult),
  addProject: command(false, "add_project", AddProjectCommand, (p) => p.project),
  archiveThread: command(false, "archive_thread", ArchiveThreadCommand, (p) => p.thread),
  branch: command(true, "branch", BranchCommand, (p) => p.leafId),
  browseProjectDirs: command(false, "browse_project_dirs", BrowseProjectDirsCommand, (p) => p),
  compact: command(true, "compact", CompactCommand, (p) => p.result),
  createThread: command(false, "create_thread", CreateThreadCommand, (p) => p.thread),
  deleteSkill: command(false, "delete_skill", DeleteSkillCommand, noResult),
  deleteThread: command(false, "delete_thread", DeleteThreadCommand, noResult),
  followUp: command(true, "follow_up", FollowUpCommand, noResult),
  getAvailableModels: command(true, "get_available_models", GetAvailableModelsCommand, (p) => [
    ...p.models,
  ]),
  getAvailableThinkingLevels: command(
    true,
    "get_available_thinking_levels",
    GetAvailableThinkingLevelsCommand,
    (p) => [...p.levels],
  ),
  getEntries: command(true, "get_entries", GetEntriesCommand, (p) => ({
    entries: [...p.entries],
    leafId: p.leafId,
    tailSeq: p.tailSeq,
  })),
  getSessionStats: command(true, "get_session_stats", GetSessionStatsCommand, (p) => p.stats),
  getState: command(true, "get_state", GetStateCommand, (p) => p.state),
  getThread: command(false, "get_thread", GetThreadCommand, (p) => p.thread),
  importPiSession: command(false, "import_pi_session", ImportPiSessionCommand, (p) => p.thread),
  importSkill: command(false, "import_skill", ImportSkillCommand, (p) => p.skill),
  listPiSessions: command(false, "list_pi_sessions", ListPiSessionsCommand, (p) => [...p.sessions]),
  listProjects: command(false, "list_projects", ListProjectsCommand, (p) => [...p.projects]),
  listSkills: command(false, "list_skills", ListSkillsCommand, (p) => [...p.skills]),
  listThreads: command(false, "list_threads", ListThreadsCommand, (p) => [...p.threads]),
  prompt: command(true, "prompt", PromptCommand, noResult),
  removeProject: command(false, "remove_project", RemoveProjectCommand, noResult),
  renameThread: command(false, "rename_thread", RenameThreadCommand, (p) => p.thread),
  setAutoCompaction: command(true, "set_auto_compaction", SetAutoCompactionCommand, noResult),
  setFollowUpMode: command(true, "set_follow_up_mode", SetFollowUpModeCommand, noResult),
  setModel: command(true, "set_model", SetModelCommand, (p) => p.model),
  setSessionName: command(true, "set_session_name", SetSessionNameCommand, noResult),
  setSteeringMode: command(true, "set_steering_mode", SetSteeringModeCommand, noResult),
  setThinkingLevel: command(true, "set_thinking_level", SetThinkingLevelCommand, (p) => p.level),
  steer: command(true, "steer", SteerCommand, noResult),
  unarchiveThread: command(false, "unarchive_thread", UnarchiveThreadCommand, (p) => p.thread),
};

/** A console's connection to the hub. Create once per process. */
export interface WireClientApi {
  readonly role: ConsoleRole;
  /** Whether the handshake is complete and the connection is live. */
  readonly isConnected: boolean;
  /** Connect once and complete the handshake, returning the server's reply. */
  readonly connect: () => Effect.Effect<HelloOk, WireError>;
  /** Connect, then keep reconnecting with backoff after unexpected closes. */
  readonly start: () => Effect.Effect<void, WireError>;
  /** Close the connection; pending commands fail with `disconnected`. */
  readonly disconnect: () => Effect.Effect<void>;
  readonly on: <K extends ClientEventKind>(
    kind: K,
    listener: (payload: ClientEvents[K]) => void,
  ) => () => void;
  readonly listThreads: () => Effect.Effect<ThreadInfo[], WireError>;
  readonly createThread: (
    name: string,
    options?: { readonly cwd?: string; readonly mode?: ThreadMode; readonly autoName?: boolean },
  ) => Effect.Effect<ThreadInfo, WireError>;
  readonly getThread: (threadId: string) => Effect.Effect<ThreadInfo, WireError>;
  readonly renameThread: (threadId: string, name: string) => Effect.Effect<ThreadInfo, WireError>;
  readonly deleteThread: (threadId: string) => Effect.Effect<void, WireError>;
  readonly archiveThread: (threadId: string) => Effect.Effect<ThreadInfo, WireError>;
  readonly unarchiveThread: (threadId: string) => Effect.Effect<ThreadInfo, WireError>;
  readonly listPiSessions: (project?: string) => Effect.Effect<PiSessionInfo[], WireError>;
  readonly importPiSession: (path: string) => Effect.Effect<ThreadInfo, WireError>;
  readonly listProjects: () => Effect.Effect<ProjectInfo[], WireError>;
  readonly addProject: (path: string) => Effect.Effect<ProjectInfo, WireError>;
  readonly removeProject: (path: string) => Effect.Effect<void, WireError>;
  /** One level of the add-project tree: a directory's subdirectories. */
  readonly browseProjectDirs: (path: string) => Effect.Effect<BrowseProjectDirsResult, WireError>;
  readonly prompt: (
    threadId: string,
    text: string,
    images?: readonly unknown[],
  ) => Effect.Effect<void, WireError>;
  readonly steer: (threadId: string, text: string) => Effect.Effect<void, WireError>;
  readonly followUp: (threadId: string, text: string) => Effect.Effect<void, WireError>;
  readonly abort: (threadId: string) => Effect.Effect<void, WireError>;
  readonly setSteeringMode: (
    threadId: string,
    mode: "all" | "one-at-a-time",
  ) => Effect.Effect<void, WireError>;
  readonly setFollowUpMode: (
    threadId: string,
    mode: "all" | "one-at-a-time",
  ) => Effect.Effect<void, WireError>;
  readonly compact: (
    threadId: string,
    customInstructions?: string,
  ) => Effect.Effect<CompactResult, WireError>;
  readonly setAutoCompaction: (
    threadId: string,
    enabled: boolean,
  ) => Effect.Effect<void, WireError>;
  readonly getAvailableModels: (threadId: string) => Effect.Effect<WireModelInfo[], WireError>;
  readonly setModel: (
    threadId: string,
    provider: string,
    modelId: string,
  ) => Effect.Effect<WireModelInfo | null, WireError>;
  readonly getAvailableThinkingLevels: (
    threadId: string,
  ) => Effect.Effect<ThinkingLevel[], WireError>;
  readonly setThinkingLevel: (
    threadId: string,
    level: ThinkingLevel,
  ) => Effect.Effect<ThinkingLevel, WireError>;
  readonly getEntries: (
    threadId: string,
    sinceSeq?: number,
  ) => Effect.Effect<{ entries: Entry[]; tailSeq: number; leafId: string | null }, WireError>;
  readonly branch: (threadId: string, entryId: string) => Effect.Effect<string | null, WireError>;
  readonly getSessionStats: (threadId: string) => Effect.Effect<SessionStats, WireError>;
  readonly setSessionName: (threadId: string, name: string) => Effect.Effect<void, WireError>;
  readonly getState: (threadId: string) => Effect.Effect<ThreadSessionState, WireError>;
  readonly listSkills: () => Effect.Effect<SkillInfo[], WireError>;
  readonly importSkill: (source: string, scope?: SkillScope) => Effect.Effect<SkillInfo, WireError>;
  readonly deleteSkill: (id: string) => Effect.Effect<void, WireError>;
}

/** A console's connection to the hub: `WireClient.make(options)` builds one. */
export class WireClient extends Context.Service<WireClient, WireClientApi>()("WireClient", {
  make: Effect.fn("WireClient.make")(function* (options: WorkerClientOptions) {
    const pendingRef = yield* Ref.make<Pending>(new Map());
    const connectRef = yield* Ref.make<Option.Option<ConnectDeferred>>(Option.none());
    const seqRef = yield* Ref.make(0);
    const listeners: ListenerRegistry = {
      close: new Set(),
      error: new Set(),
      event: new Set(),
      hello_ok: new Set(),
      thread_changed: new Set(),
    };
    const reconnectEnabled = options.reconnect ?? false;
    const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    const deps: ClientDeps = {
      connectRef,
      listeners,
      pendingRef,
      role: options.role,
      token: options.token,
      url: options.url,
      version: options.version ?? WIRE_VERSION,
    };
    const actor = yield* Machine.spawn(makeMachine(deps));
    yield* actor.start;

    const connect = Effect.fn("connect")(function* () {
      const deferred = yield* Deferred.make<HelloOk, WireError>();
      yield* Ref.set(connectRef, Option.some(deferred));
      yield* actor.send(ClientEvent.ConnectRequested);
      const hello = yield* Deferred.await(deferred).pipe(
        Effect.ensuring(Ref.set(connectRef, Option.none())),
      );
      // The hello_ok transition has run, but the actor may not have landed
      // on Connected yet; wait for the state so a command immediately after
      // connect() sees a Connected snapshot.
      yield* actor.waitFor((state) => ClientState.$is("Connected")(state));
      return hello;
    });

    const waitForClose = () =>
      actor
        .waitFor((state) => !ClientState.$is("Connected")(state))
        .pipe(
          Effect.flatMap(() =>
            Effect.fail(new WireError({ code: "disconnected", message: "connection closed" })),
          ),
        );

    const start = () => {
      const attempt = () => connect().pipe(Effect.flatMap(() => waitForClose()));
      if (!reconnectEnabled) {
        return attempt();
      }
      // Handshake rejections fail through — a bad token must not spin forever.
      return attempt().pipe(
        Effect.catchIf((error) => error.code === "handshake", Effect.fail),
        Effect.retry(Schedule.exponential("200 millis", 2)),
      );
    };

    const disconnect = Effect.fn("disconnect")(function* () {
      yield* failAllPending(
        deps,
        new WireError({ code: "disconnected", message: "client disconnected" }),
      );
      yield* actor.send(ClientEvent.DisconnectRequested);
      // Drain: the machine closes the socket (DisconnectRequested), then
      // the actor stops after the queue is empty.
      yield* actor.drain;
    });

    const on = <K extends ClientEventKind>(
      kind: K,
      listener: (payload: ClientEvents[K]) => void,
    ) => {
      const set = deps.listeners[kind];
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    };

    const nextRequestId = () =>
      Ref.updateAndGet(seqRef, (n) => n + 1).pipe(Effect.map((n) => `req_${n}`));

    const request = Effect.fn("request")(function* <
      A extends object,
      K extends ResponsePayload["_tag"],
      T,
    >(spec: CommandSpec<A, K, T>, args: A, threadId?: string) {
      const state = yield* actor.snapshot;
      if (!ClientState.$is("Connected")(state)) {
        return yield* Effect.fail(
          new WireError({ code: "disconnected", message: "not connected" }),
        );
      }
      const id = yield* nextRequestId();
      const frame = commandFrame(id, spec.schema.make(args), threadId);
      const deferred = yield* Deferred.make<ResponsePayload, WireError>();
      yield* Ref.update(pendingRef, (pending) => new Map(pending).set(id, deferred));
      yield* actor.send(ClientEvent.CommandSent({ frame, id }));
      const payload = yield* Effect.ensuring(
        Deferred.await(deferred).pipe(
          Effect.timeout(requestTimeoutMs),
          Effect.mapError((error) =>
            Cause.isTimeoutError(error)
              ? new WireError({ code: "timeout", message: `command ${id} timed out` })
              : error,
          ),
        ),
        // The response handler already removed the entry on success; this
        // covers timeout and interruption.
        Ref.update(pendingRef, (pending) => {
          const next = new Map(pending);
          next.delete(id);
          return next;
        }),
      );
      if (isResponseVariant(payload, spec.tag)) {
        return spec.extract(payload);
      }
      return yield* Effect.fail(
        new WireError({
          code: "decode",
          message: `expected a ${spec.tag} response, got ${payload._tag}`,
        }),
      );
    });

    return {
      abort: (threadId) => request(COMMANDS.abort, {}, threadId),
      addProject: (path) => request(COMMANDS.addProject, { path }),
      archiveThread: (threadId) => request(COMMANDS.archiveThread, { threadId }),
      branch: (threadId, entryId) => request(COMMANDS.branch, { entryId }, threadId),
      browseProjectDirs: (path) => request(COMMANDS.browseProjectDirs, { path }),
      compact: (threadId, customInstructions) =>
        request(COMMANDS.compact, { customInstructions }, threadId),
      connect,
      createThread: (name, createOptions) =>
        request(COMMANDS.createThread, { name, ...createOptions }),
      deleteSkill: (id) => request(COMMANDS.deleteSkill, { id }),
      deleteThread: (threadId) => request(COMMANDS.deleteThread, { threadId }),
      disconnect,
      followUp: (threadId, text) => request(COMMANDS.followUp, { text }, threadId),
      getAvailableModels: (threadId) => request(COMMANDS.getAvailableModels, {}, threadId),
      getAvailableThinkingLevels: (threadId) =>
        request(COMMANDS.getAvailableThinkingLevels, {}, threadId),
      getEntries: (threadId, sinceSeq) => request(COMMANDS.getEntries, { sinceSeq }, threadId),
      getSessionStats: (threadId) => request(COMMANDS.getSessionStats, {}, threadId),
      getState: (threadId) => request(COMMANDS.getState, {}, threadId),
      getThread: (threadId) => request(COMMANDS.getThread, { threadId }),
      importPiSession: (path) => request(COMMANDS.importPiSession, { path }),
      importSkill: (source, scope) => request(COMMANDS.importSkill, { scope, source }),
      get isConnected() {
        return actor.sync.matches("Connected");
      },
      listPiSessions: (project) => request(COMMANDS.listPiSessions, { project }),
      listProjects: () => request(COMMANDS.listProjects, {}),
      listSkills: () => request(COMMANDS.listSkills, {}),
      listThreads: () => request(COMMANDS.listThreads, {}),
      on,
      prompt: (threadId, text, images) => request(COMMANDS.prompt, { images, text }, threadId),
      removeProject: (path) => request(COMMANDS.removeProject, { path }),
      renameThread: (threadId, name) => request(COMMANDS.renameThread, { name, threadId }),
      role: options.role,
      setAutoCompaction: (threadId, enabled) =>
        request(COMMANDS.setAutoCompaction, { enabled }, threadId),
      setFollowUpMode: (threadId, mode) => request(COMMANDS.setFollowUpMode, { mode }, threadId),
      setModel: (threadId, provider, modelId) =>
        request(COMMANDS.setModel, { modelId, provider }, threadId),
      setSessionName: (threadId, name) => request(COMMANDS.setSessionName, { name }, threadId),
      setSteeringMode: (threadId, mode) => request(COMMANDS.setSteeringMode, { mode }, threadId),
      setThinkingLevel: (threadId, level) =>
        request(COMMANDS.setThinkingLevel, { level }, threadId),
      start,
      steer: (threadId, text) => request(COMMANDS.steer, { text }, threadId),
      unarchiveThread: (threadId) => request(COMMANDS.unarchiveThread, { threadId }),
    };
  }),
}) {}
