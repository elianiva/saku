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
 * `makeWireClient` spawns the actor and returns the client value;
 * `connect` completes the handshake and returns the server's `HelloOk`;
 * `disconnect` fails pending requests, closes the socket, and drains the
 * actor.
 */

import { Cause, Deferred, Effect, Option, Ref, Result, Schedule, Schema } from "effect";
import { Event, Machine, State, type MachineType } from "effect-machine";
import type {
  CompactResult,
  Entry,
  SessionStats,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";

import { ConsoleRole, Hello, HelloOk } from "./hello.ts";
import { WireCommand, WireEvent } from "./envelope.ts";
import { decodeFrame, parseFrame, serializeFrame } from "./transport.ts";
import { ThreadCommand, ThreadInfo, type ThreadMode } from "./thread.ts";
import {
  CreateThreadCommand,
  DeleteThreadCommand,
  GetThreadCommand,
  ListThreadsCommand,
  RenameThreadCommand,
} from "./thread.ts";
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
  ResponsePayload,
  SessionCommand,
  type SessionResponse,
  SetAutoCompactionCommand,
  SetFollowUpModeCommand,
  SetModelCommand,
  SetSessionNameCommand,
  SetSteeringModeCommand,
  SetThinkingLevelCommand,
  SteerCommand,
  type SessionWireEvent,
  ThreadSessionState,
  WireModelInfo,
} from "./session.ts";
import {
  DeleteSkillCommand,
  ImportSkillCommand,
  ListSkillsCommand,
  SkillCommand,
  SkillInfo,
  type SkillScope,
} from "./skills.ts";
import {
  ImportPiSessionCommand,
  ListPiSessionsCommand,
  PiSessionCommand,
  PiSessionInfo,
} from "./pi-sessions.ts";
import { WIRE_VERSION } from "./version.ts";

export class WireError extends Schema.TaggedError<WireError>()("WireError", {
  code: Schema.Literals([
    "disconnected",
    "handshake",
    "timeout",
    "decode",
    "refused",
    "command_failed",
  ]),
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

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

// ---------------------------------------------------------------------------
// The connection state machine
// ---------------------------------------------------------------------------

/** Connection lifecycle. The socket rides the state it belongs to. */
const ClientState = State({
  Disconnected: {},
  /** The socket is being created/opened. */
  Connecting: {},
  /** Socket open; `hello` sent, awaiting `hello_ok`. */
  Handshaking: { socket: Schema.instanceOf(WebSocket) },
  /** Handshake done; commands flow. */
  Connected: { socket: Schema.instanceOf(WebSocket) },
});
type ClientStateV = Schema.Schema.Type<typeof ClientState>;

/** Everything the machine reacts to: API calls and socket events. */
const ClientEvent = Event({
  ConnectRequested: {},
  DisconnectRequested: {},
  /** The socket opened; carries the socket into the handshake. */
  Opened: { socket: Schema.instanceOf(WebSocket) },
  /** The socket closed. */
  Closed: {},
  /** The socket errored (connection refused, DNS failure). */
  Errored: {},
  /** One raw JSON line from the server. */
  Frame: { line: Schema.String },
  /** A wire command the API layer already correlated (id + frame). */
  CommandSent: { id: Schema.String, frame: Schema.Unknown },
});
type ClientEventV = Schema.Schema.Type<typeof ClientEvent>;

/** Correlate a request id with the deferred that awaits its response. */
type Pending = ReadonlyMap<string, Deferred.Deferred<ResponsePayload, WireError>>;

/** The in-flight handshake's deferred; None when no connect is pending. */
type ConnectDeferred = Deferred.Deferred<HelloOk, WireError>;

/** Sync subscription registry: callback sets per event kind (framework boundary). */
type Listener = (payload: ClientEvents[ClientEventKind]) => void;
type ListenerMap = Map<ClientEventKind, Set<Listener>>;

interface ClientDeps {
  readonly url: string;
  readonly token: string;
  readonly role: ConsoleRole;
  readonly version: string;
  readonly pendingRef: Ref.Ref<Pending>;
  readonly connectRef: Ref.Ref<Option.Option<ConnectDeferred>>;
  readonly listeners: ListenerMap;
}

const DECODE = Schema.decodeUnknownSync(WireEvent);

/**
 * The single boundary where pi's opaque payloads cross to pi's types
 * (ADR 0005): pi's vocabulary travels the wire unvalidated — saku never
 * re-schemas it — so the narrow to pi's own types happens here, by name,
 * never with a bare `as` in the method bodies.
 */
const narrowPi = <T>(value: unknown): T => value as T;

/**
 * The single boundary where a decoded response payload is narrowed to the
 * variant its command carries: the wire schema validates the frame, not the
 * command↔response pairing, so a server answering the wrong variant is a
 * decodable `decode` failure here, not an undefined read downstream.
 */
const narrowResponse = <K extends ResponsePayload["_tag"]>(
  payload: ResponsePayload,
  tag: K,
): Effect.Effect<SessionResponse<K>, WireError, never> =>
  payload._tag === tag
    ? Effect.succeed(payload as SessionResponse<K>)
    : Effect.fail(
        new WireError({
          code: "decode",
          message: `expected a ${tag} response, got ${payload._tag}`,
        }),
      );

/** Settle the pending handshake with an outcome; a stale ref is a no-op. */
const settleConnect = (
  deps: ClientDeps,
  outcome: Result.Result<HelloOk, WireError>,
): Effect.Effect<void, never, never> =>
  Ref.getAndSet(deps.connectRef, Option.none()).pipe(
    Effect.flatMap((pending) =>
      Option.match(pending, {
        onNone: () => Effect.void,
        onSome: (deferred) =>
          Result.match(outcome, {
            // The settle result is discarded (the boolean is the settle
            // success) — align both arms on void so inference stays stable
            // across programs (`Deferred` returns `Effect<boolean>`).
            onSuccess: (hello) => Deferred.succeed(deferred, hello).pipe(Effect.asVoid),
            onFailure: (error) => Deferred.fail(deferred, error).pipe(Effect.asVoid),
          }),
      }),
    ),
  );

const emit = (
  deps: ClientDeps,
  kind: ClientEventKind,
  payload: ClientEvents[ClientEventKind],
): Effect.Effect<void, never, never> =>
  Effect.sync(() => {
    const set = deps.listeners.get(kind);
    if (set === undefined) return;
    for (const listener of set) {
      const result = Result.try(() => listener(payload));
      if (Result.isFailure(result)) {
        console.error("[wire] listener failed:", result.failure);
      }
    }
  });

/** Fail every in-flight request; the pending map is drained. */
const failAllPending = (deps: ClientDeps, error: WireError): Effect.Effect<void, never, never> =>
  Ref.getAndSet(deps.pendingRef, new Map()).pipe(
    Effect.flatMap((pending) =>
      Effect.forEach(pending, ([, deferred]) => Deferred.fail(deferred, error), { discard: true }),
    ),
  );

type ClientStateDef = (typeof ClientState)["_definition"];
type ClientEventDef = (typeof ClientEvent)["_definition"];

/**
 * The connection machine. Transitions are total: a decode failure or a
 * closed socket becomes an error event or a failed deferred, never a
 * defect. Socket listeners are wired by the `Connecting` spawn effect and
 * cast their events into the actor.
 */
const makeMachine = (
  deps: ClientDeps,
): MachineType<ClientStateV, ClientEventV, never, ClientStateDef, ClientEventDef> =>
  Machine.make({
    state: ClientState,
    event: ClientEvent,
    initial: ClientState.Disconnected,
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
          // ArrayBuffers; decodeFrame rejects anything else.
          const line = Result.try(() => decodeFrame(message.data));
          if (Result.isSuccess(line)) {
            void Effect.runFork(self.send(ClientEvent.Frame({ line: line.success })));
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
        const sent = Result.try(() =>
          event.socket.send(
            serializeFrame(
              Hello.make({ token: deps.token, role: deps.role, version: deps.version }),
            ),
          ),
        );
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
        if (Option.isNone(decoded)) return state; // malformed; the error event was emitted
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
        return state; // not the handshake reply; keep reading
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
        yield* emit(deps, "close", undefined);
        return ClientState.Disconnected;
      }),
    )
    .on(ClientState.Connected, ClientEvent.CommandSent, ({ state, event }) =>
      Effect.gen(function* () {
        const sent = Result.try(() => state.socket.send(serializeFrame(event.frame)));
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
        const socket = ClientState.$match(state as ClientStateV, {
          Disconnected: () => Option.none<WebSocket>(),
          Connecting: () => Option.none<WebSocket>(),
          Handshaking: (s) => Option.some(s.socket),
          Connected: (s) => Option.some(s.socket),
        });
        if (Option.isSome(socket)) {
          yield* Effect.sync(() => socket.value.close());
        }
        return ClientState.Disconnected;
      }),
    );

// ---------------------------------------------------------------------------
// The command registry: one row per wire command (its schema/make, thread
// scoping, response extractor). Every client method below is derived from
// its row, so the request shape and the response extraction live in one
// place per command.
// ---------------------------------------------------------------------------

interface CommandSpec<A extends object, K extends ResponsePayload["_tag"], T> {
  /** The command's schema; its static `make` builds the wire payload. */
  readonly schema: {
    readonly make: (args: A) => SessionCommand | ThreadCommand | SkillCommand | PiSessionCommand;
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
    readonly make: (args: A) => SessionCommand | ThreadCommand | SkillCommand | PiSessionCommand;
  },
  extract: (payload: SessionResponse<K>) => T,
): CommandSpec<A, K, T> => ({ schema, threadScoped, tag, extract });

/** One row per wire command; the client methods are thin derivations. */
const COMMANDS = {
  // -- threads (hub-level: no threadId on the frame)
  listThreads: command(false, "list_threads", ListThreadsCommand, (p) => [...p.threads]),
  createThread: command(false, "create_thread", CreateThreadCommand, (p) => p.thread),
  getThread: command(false, "get_thread", GetThreadCommand, (p) => p.thread),
  renameThread: command(false, "rename_thread", RenameThreadCommand, (p) => p.thread),
  deleteThread: command(false, "delete_thread", DeleteThreadCommand, () => undefined),
  // -- session (thread-scoped)
  prompt: command(true, "prompt", PromptCommand, () => undefined),
  steer: command(true, "steer", SteerCommand, () => undefined),
  followUp: command(true, "follow_up", FollowUpCommand, () => undefined),
  abort: command(true, "abort", AbortCommand, () => undefined),
  setSteeringMode: command(true, "set_steering_mode", SetSteeringModeCommand, () => undefined),
  setFollowUpMode: command(true, "set_follow_up_mode", SetFollowUpModeCommand, () => undefined),
  compact: command(true, "compact", CompactCommand, (p) => narrowPi<CompactResult>(p.result)),
  setAutoCompaction: command(
    true,
    "set_auto_compaction",
    SetAutoCompactionCommand,
    () => undefined,
  ),
  getAvailableModels: command(true, "get_available_models", GetAvailableModelsCommand, (p) => [
    ...p.models,
  ]),
  setModel: command(true, "set_model", SetModelCommand, (p) => p.model),
  getAvailableThinkingLevels: command(
    true,
    "get_available_thinking_levels",
    GetAvailableThinkingLevelsCommand,
    (p) => [...p.levels],
  ),
  setThinkingLevel: command(true, "set_thinking_level", SetThinkingLevelCommand, (p) => p.level),
  getEntries: command(true, "get_entries", GetEntriesCommand, (p) => ({
    entries: narrowPi<Entry[]>(p.entries),
    tailSeq: p.tailSeq,
    leafId: p.leafId,
  })),
  branch: command(true, "branch", BranchCommand, (p) => p.leafId),
  getSessionStats: command(true, "get_session_stats", GetSessionStatsCommand, (p) =>
    narrowPi<SessionStats>(p.stats),
  ),
  setSessionName: command(true, "set_session_name", SetSessionNameCommand, () => undefined),
  getState: command(true, "get_state", GetStateCommand, (p) => p.state),
  // -- skills (hub-level)
  listSkills: command(false, "list_skills", ListSkillsCommand, (p) => [...p.skills]),
  importSkill: command(false, "import_skill", ImportSkillCommand, (p) => p.skill),
  deleteSkill: command(false, "delete_skill", DeleteSkillCommand, () => undefined),
  // -- pi sessions (local-daemon-only: pi's files live on the user's machine)
  listPiSessions: command(false, "list_pi_sessions", ListPiSessionsCommand, (p) => [
    ...p.sessions,
  ]),
  importPiSession: command(false, "import_pi_session", ImportPiSessionCommand, (p) => p.thread),
};

/** Resolve a correlated request; a late/abandoned id is a no-op. */
const resolveResponse = (
  deps: ClientDeps,
  id: string,
  outcome: Result.Result<ResponsePayload, WireError>,
): Effect.Effect<void, never, never> =>
  Ref.getAndUpdate(deps.pendingRef, (pending) => {
    const next = new Map(pending);
    next.delete(id);
    return next;
  }).pipe(
    Effect.flatMap((pending) => {
      const deferred = pending.get(id);
      if (deferred === undefined) return Effect.void;
      return Result.match(outcome, {
        onSuccess: (payload) => Deferred.succeed(deferred, payload),
        onFailure: (error) => Deferred.fail(deferred, error),
      });
    }),
  );

/** Dispatch one decoded server frame in `Connected`. */
const handleFrame = (deps: ClientDeps, frame: WireEvent): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    switch (frame._tag) {
      case "response":
        yield* frame.ok
          ? resolveResponse(deps, frame.id, Result.succeed(frame.payload))
          : resolveResponse(
              deps,
              frame.id,
              Result.fail(new WireError({ code: "command_failed", message: frame.error })),
            );
        return;
      case "event":
        // The envelope's event payload is opaque JSON by design (ADR 0005:
        // pi's event vocabulary crosses the wire unvalidated); the console
        // narrows it to the projected `SessionWireEvent` at this boundary.
        yield* emit(deps, "event", {
          threadId: frame.threadId,
          event: narrowPi<SessionWireEvent>(frame.event),
        });
        return;
      case "thread_changed":
        yield* emit(deps, "thread_changed", frame.thread);
        return;
      case "hello_ok":
        yield* emit(deps, "hello_ok", frame);
        return;
      case "error":
        yield* emit(deps, "error", { message: frame.message });
        return;
    }
  });

/** Decode one frame line, or surface the failure as an error event. */
const decodeFrameLine = (
  deps: ClientDeps,
  line: string,
): Effect.Effect<WireEvent, WireError, never> =>
  Effect.gen(function* () {
    const parsed = Result.try(() => parseFrame(line));
    if (Result.isFailure(parsed)) {
      yield* emit(deps, "error", { message: "malformed JSON frame from server" });
      return yield* Effect.fail(new WireError({ code: "decode", message: "malformed frame" }));
    }
    const decoded = Result.try(() => DECODE(parsed.success));
    if (Result.isFailure(decoded)) {
      yield* emit(deps, "error", { message: `undecodable wire frame: ${String(decoded.failure)}` });
      return yield* Effect.fail(new WireError({ code: "decode", message: "undecodable frame" }));
    }
    return decoded.success;
  });

// ---------------------------------------------------------------------------
// The client value
// ---------------------------------------------------------------------------

/** A console's connection to the hub. Create once per process. */
export interface WireClient {
  readonly role: ConsoleRole;
  /** Whether the handshake is complete and the connection is live. */
  readonly isConnected: boolean;
  /** Connect once and complete the handshake, returning the server's reply. */
  readonly connect: () => Effect.Effect<HelloOk, WireError, never>;
  /** Connect, then keep reconnecting with backoff after unexpected closes. */
  readonly start: () => Effect.Effect<void, WireError, never>;
  /** Close the connection; pending commands fail with `disconnected`. */
  readonly disconnect: () => Effect.Effect<void, never>;
  readonly on: <K extends ClientEventKind>(
    kind: K,
    listener: (payload: ClientEvents[K]) => void,
  ) => () => void;
  // -- threads
  readonly listThreads: () => Effect.Effect<ThreadInfo[], WireError, never>;
  readonly createThread: (
    name: string,
    options?: { readonly cwd?: string; readonly mode?: ThreadMode; readonly autoName?: boolean },
  ) => Effect.Effect<ThreadInfo, WireError, never>;
  readonly getThread: (threadId: string) => Effect.Effect<ThreadInfo, WireError, never>;
  readonly renameThread: (
    threadId: string,
    name: string,
  ) => Effect.Effect<ThreadInfo, WireError, never>;
  readonly deleteThread: (threadId: string) => Effect.Effect<void, WireError, never>;
  // -- pi sessions (local-daemon-only: pi's files live on the user's machine)
  readonly listPiSessions: () => Effect.Effect<PiSessionInfo[], WireError, never>;
  readonly importPiSession: (path: string) => Effect.Effect<ThreadInfo, WireError, never>;
  // -- session
  readonly prompt: (
    threadId: string,
    text: string,
    images?: ReadonlyArray<unknown>,
  ) => Effect.Effect<void, WireError, never>;
  readonly steer: (threadId: string, text: string) => Effect.Effect<void, WireError, never>;
  readonly followUp: (threadId: string, text: string) => Effect.Effect<void, WireError, never>;
  readonly abort: (threadId: string) => Effect.Effect<void, WireError, never>;
  readonly setSteeringMode: (
    threadId: string,
    mode: "all" | "one-at-a-time",
  ) => Effect.Effect<void, WireError, never>;
  readonly setFollowUpMode: (
    threadId: string,
    mode: "all" | "one-at-a-time",
  ) => Effect.Effect<void, WireError, never>;
  readonly compact: (
    threadId: string,
    customInstructions?: string,
  ) => Effect.Effect<CompactResult, WireError, never>;
  readonly setAutoCompaction: (
    threadId: string,
    enabled: boolean,
  ) => Effect.Effect<void, WireError, never>;
  readonly getAvailableModels: (
    threadId: string,
  ) => Effect.Effect<WireModelInfo[], WireError, never>;
  readonly setModel: (
    threadId: string,
    provider: string,
    modelId: string,
  ) => Effect.Effect<WireModelInfo | null, WireError, never>;
  readonly getAvailableThinkingLevels: (
    threadId: string,
  ) => Effect.Effect<ThinkingLevel[], WireError, never>;
  readonly setThinkingLevel: (
    threadId: string,
    level: ThinkingLevel,
  ) => Effect.Effect<ThinkingLevel, WireError, never>;
  readonly getEntries: (
    threadId: string,
    sinceSeq?: number,
  ) => Effect.Effect<
    { entries: Entry[]; tailSeq: number; leafId: string | null },
    WireError,
    never
  >;
  readonly branch: (
    threadId: string,
    entryId: string,
  ) => Effect.Effect<string | null, WireError, never>;
  readonly getSessionStats: (threadId: string) => Effect.Effect<SessionStats, WireError, never>;
  readonly setSessionName: (
    threadId: string,
    name: string,
  ) => Effect.Effect<void, WireError, never>;
  readonly getState: (threadId: string) => Effect.Effect<ThreadSessionState, WireError, never>;
  // -- skills
  readonly listSkills: () => Effect.Effect<SkillInfo[], WireError, never>;
  readonly importSkill: (
    source: string,
    scope?: SkillScope,
  ) => Effect.Effect<SkillInfo, WireError, never>;
  readonly deleteSkill: (id: string) => Effect.Effect<void, WireError, never>;
}

/** Spawn the client's actor and return the client value. */
export const makeWireClient = (
  options: WorkerClientOptions,
): Effect.Effect<WireClient, never, never> =>
  Effect.gen(function* () {
    const pendingRef = yield* Ref.make<Pending>(new Map());
    const connectRef = yield* Ref.make<Option.Option<ConnectDeferred>>(Option.none());
    const seqRef = yield* Ref.make(0);
    const listeners: ListenerMap = new Map();
    const reconnectEnabled = options.reconnect ?? false;
    const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    const deps: ClientDeps = {
      url: options.url,
      token: options.token,
      role: options.role,
      version: options.version ?? WIRE_VERSION,
      pendingRef,
      connectRef,
      listeners,
    };
    const actor = yield* Machine.spawn(makeMachine(deps));
    yield* actor.start;

    const connect = (): Effect.Effect<HelloOk, WireError, never> =>
      Effect.gen(function* () {
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

    const waitForClose = (): Effect.Effect<void, WireError, never> =>
      actor
        .waitFor((state) => !ClientState.$is("Connected")(state))
        .pipe(
          Effect.flatMap(() =>
            Effect.fail(new WireError({ code: "disconnected", message: "connection closed" })),
          ),
        );

    const start = (): Effect.Effect<void, WireError, never> => {
      const attempt = (): Effect.Effect<void, WireError, never> =>
        connect().pipe(Effect.flatMap(() => waitForClose()));
      if (!reconnectEnabled) return attempt();
      // Handshake rejections fail through — a bad token must not spin forever.
      return attempt().pipe(
        Effect.catchIf(
          (error) => error.code === "handshake",
          (error) => Effect.fail(error),
        ),
        Effect.retry(Schedule.exponential("200 millis", 2)),
      );
    };

    const disconnect = (): Effect.Effect<void, never, never> =>
      Effect.gen(function* () {
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
    ): (() => void) => {
      let set = listeners.get(kind);
      if (set === undefined) {
        set = new Set();
        listeners.set(kind, set);
      }
      set.add(listener as Listener);
      return () => {
        set.delete(listener as Listener);
      };
    };

    // -- command plumbing ----------------------------------------------------

    const nextRequestId = (): Effect.Effect<string, never, never> =>
      Ref.updateAndGet(seqRef, (n) => n + 1).pipe(Effect.map((n) => `req_${n}`));

    const request = <A extends object, K extends ResponsePayload["_tag"], T>(
      spec: CommandSpec<A, K, T>,
      args: A,
      threadId?: string,
    ): Effect.Effect<T, WireError, never> =>
      Effect.gen(function* () {
        const state = yield* actor.snapshot;
        if (!ClientState.$is("Connected")(state)) {
          return yield* Effect.fail(
            new WireError({ code: "disconnected", message: "not connected" }),
          );
        }
        const id = yield* nextRequestId();
        const frame: WireCommand = {
          _tag: "command",
          id,
          ...(threadId === undefined ? {} : { threadId }),
          command: spec.schema.make(args),
        };
        const deferred = yield* Deferred.make<ResponsePayload, WireError>();
        yield* Ref.update(pendingRef, (pending) => new Map(pending).set(id, deferred));
        yield* actor.send(ClientEvent.CommandSent({ id, frame }));
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
        const variant = yield* narrowResponse(payload, spec.tag);
        return spec.extract(variant);
      });

    return {
      role: options.role,
      get isConnected() {
        return actor.sync.matches("Connected");
      },
      connect,
      start,
      disconnect,
      on,
      // -- thread commands
      listThreads: () => request(COMMANDS.listThreads, {}),
      createThread: (name, options) => request(COMMANDS.createThread, { name, ...options }),
      getThread: (threadId) => request(COMMANDS.getThread, { threadId }),
      renameThread: (threadId, name) => request(COMMANDS.renameThread, { threadId, name }),
      deleteThread: (threadId) => request(COMMANDS.deleteThread, { threadId }),
      // -- session commands
      prompt: (threadId, text, images) => request(COMMANDS.prompt, { text, images }, threadId),
      steer: (threadId, text) => request(COMMANDS.steer, { text }, threadId),
      followUp: (threadId, text) => request(COMMANDS.followUp, { text }, threadId),
      abort: (threadId) => request(COMMANDS.abort, {}, threadId),
      setSteeringMode: (threadId, mode) => request(COMMANDS.setSteeringMode, { mode }, threadId),
      setFollowUpMode: (threadId, mode) => request(COMMANDS.setFollowUpMode, { mode }, threadId),
      compact: (threadId, customInstructions) =>
        request(COMMANDS.compact, { customInstructions }, threadId),
      setAutoCompaction: (threadId, enabled) =>
        request(COMMANDS.setAutoCompaction, { enabled }, threadId),
      getAvailableModels: (threadId) => request(COMMANDS.getAvailableModels, {}, threadId),
      setModel: (threadId, provider, modelId) =>
        request(COMMANDS.setModel, { provider, modelId }, threadId),
      getAvailableThinkingLevels: (threadId) =>
        request(COMMANDS.getAvailableThinkingLevels, {}, threadId),
      setThinkingLevel: (threadId, level) =>
        request(COMMANDS.setThinkingLevel, { level }, threadId),
      getEntries: (threadId, sinceSeq) => request(COMMANDS.getEntries, { sinceSeq }, threadId),
      branch: (threadId, entryId) => request(COMMANDS.branch, { entryId }, threadId),
      getSessionStats: (threadId) => request(COMMANDS.getSessionStats, {}, threadId),
      setSessionName: (threadId, name) => request(COMMANDS.setSessionName, { name }, threadId),
      getState: (threadId) => request(COMMANDS.getState, {}, threadId),
      // -- skills commands
      listSkills: () => request(COMMANDS.listSkills, {}),
      importSkill: (source, scope) => request(COMMANDS.importSkill, { source, scope }),
      deleteSkill: (id) => request(COMMANDS.deleteSkill, { id }),
      // -- pi session commands
      listPiSessions: () => request(COMMANDS.listPiSessions, {}),
      importPiSession: (path) => request(COMMANDS.importPiSession, { path }),
    };
  });
