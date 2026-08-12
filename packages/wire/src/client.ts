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
import { Event, Machine, State, type ActorRef, type MachineType } from "effect-machine";
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
import { CreateThreadCommand, DeleteThreadCommand, GetThreadCommand, ListThreadsCommand, RenameThreadCommand } from "./thread.ts";
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
import { WIRE_VERSION } from "./version.ts";

export class WireError extends Schema.TaggedError<WireError>()("WireError", {
  code: Schema.Literals([
    "disconnected",
    "handshake",
    "timeout",
    "decode",
    "refused",
    "rejected",
    "unknown_thread",
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
type Pending = ReadonlyMap<string, Deferred.Deferred<unknown, WireError>>;

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
            onSuccess: (hello) => Deferred.succeed(deferred, hello),
            onFailure: (error) => Deferred.fail(deferred, error),
          }),
      }),
    ),
  );

const emit = (deps: ClientDeps, kind: ClientEventKind, payload: ClientEvents[ClientEventKind]): Effect.Effect<void, never, never> =>
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
            Result.fail(new WireError({ code: "disconnected", message: "socket closed before hello" })),
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
          Result.fail(new WireError({ code: "refused", message: "connection to the server failed" })),
        );
        // The close event follows and moves the machine to Disconnected.
        return ClientState.Connecting;
      }),
    )
    .on(ClientState.Connecting, ClientEvent.Closed, () =>
      Effect.gen(function* () {
        yield* settleConnect(
          deps,
          Result.fail(new WireError({ code: "disconnected", message: "connection closed before open" })),
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
          Result.fail(new WireError({ code: "disconnected", message: "connection closed during handshake" })),
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
        yield* failAllPending(deps, new WireError({ code: "disconnected", message: "connection closed" }));
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

/** Resolve a correlated request; a late/abandoned id is a no-op. */
const resolveResponse = (
  deps: ClientDeps,
  id: string,
  outcome: Result.Result<unknown, WireError>,
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
        yield* emit(deps, "event", { threadId: frame.threadId, event: frame.event as SessionWireEvent });
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
const decodeFrameLine = (deps: ClientDeps, line: string): Effect.Effect<WireEvent, WireError, never> =>
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
  readonly on: <K extends ClientEventKind>(kind: K, listener: (payload: ClientEvents[K]) => void) => () => void;
  // -- threads
  readonly listThreads: () => Effect.Effect<ThreadInfo[], WireError, never>;
  readonly createThread: (
    name: string,
    options?: { readonly cwd?: string; readonly mode?: ThreadMode; readonly autoName?: boolean },
  ) => Effect.Effect<ThreadInfo, WireError, never>;
  readonly getThread: (threadId: string) => Effect.Effect<ThreadInfo, WireError, never>;
  readonly renameThread: (threadId: string, name: string) => Effect.Effect<ThreadInfo, WireError, never>;
  readonly deleteThread: (threadId: string) => Effect.Effect<void, WireError, never>;
  // -- session
  readonly prompt: (threadId: string, text: string, images?: ReadonlyArray<unknown>) => Effect.Effect<void, WireError, never>;
  readonly steer: (threadId: string, text: string) => Effect.Effect<void, WireError, never>;
  readonly followUp: (threadId: string, text: string) => Effect.Effect<void, WireError, never>;
  readonly abort: (threadId: string) => Effect.Effect<void, WireError, never>;
  readonly setSteeringMode: (threadId: string, mode: "all" | "one-at-a-time") => Effect.Effect<void, WireError, never>;
  readonly setFollowUpMode: (threadId: string, mode: "all" | "one-at-a-time") => Effect.Effect<void, WireError, never>;
  readonly compact: (threadId: string, customInstructions?: string) => Effect.Effect<CompactResult, WireError, never>;
  readonly setAutoCompaction: (threadId: string, enabled: boolean) => Effect.Effect<void, WireError, never>;
  readonly getAvailableModels: (threadId: string) => Effect.Effect<WireModelInfo[], WireError, never>;
  readonly setModel: (threadId: string, provider: string, modelId: string) => Effect.Effect<WireModelInfo | null, WireError, never>;
  readonly getAvailableThinkingLevels: (threadId: string) => Effect.Effect<ThinkingLevel[], WireError, never>;
  readonly setThinkingLevel: (threadId: string, level: ThinkingLevel) => Effect.Effect<ThinkingLevel, WireError, never>;
  readonly getEntries: (
    threadId: string,
    sinceSeq?: number,
  ) => Effect.Effect<{ entries: Entry[]; tailSeq: number; leafId: string | null }, WireError, never>;
  readonly branch: (threadId: string, entryId: string) => Effect.Effect<string | null, WireError, never>;
  readonly getSessionStats: (threadId: string) => Effect.Effect<SessionStats, WireError, never>;
  readonly setSessionName: (threadId: string, name: string) => Effect.Effect<void, WireError, never>;
  readonly getState: (threadId: string) => Effect.Effect<ThreadSessionState, WireError, never>;
  // -- skills
  readonly listSkills: () => Effect.Effect<SkillInfo[], WireError, never>;
  readonly importSkill: (source: string, scope?: SkillScope) => Effect.Effect<SkillInfo, WireError, never>;
  readonly deleteSkill: (id: string) => Effect.Effect<void, WireError, never>;
}

/** Spawn the client's actor and return the client value. */
export const makeWireClient = (options: WorkerClientOptions): Effect.Effect<WireClient, never, never> =>
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
      actor.waitFor((state) => !ClientState.$is("Connected")(state)).pipe(
        Effect.flatMap(() => Effect.fail(new WireError({ code: "disconnected", message: "connection closed" }))),
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
        yield* failAllPending(deps, new WireError({ code: "disconnected", message: "client disconnected" }));
        yield* actor.send(ClientEvent.DisconnectRequested);
        // Drain: the machine closes the socket (DisconnectRequested), then
        // the actor stops after the queue is empty.
        yield* actor.drain;
      });

    const on = <K extends ClientEventKind>(kind: K, listener: (payload: ClientEvents[K]) => void): (() => void) => {
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

    const request = <TPayload extends ResponsePayload>(
      command: SessionCommand | ThreadCommand | SkillCommand,
      threadId?: string,
    ): Effect.Effect<TPayload, WireError, never> =>
      Effect.gen(function* () {
        const state = yield* actor.snapshot;
        if (!ClientState.$is("Connected")(state)) {
          return yield* Effect.fail(new WireError({ code: "disconnected", message: "not connected" }));
        }
        const id = yield* nextRequestId();
        const frame: WireCommand = {
          _tag: "command",
          id,
          ...(threadId === undefined ? {} : { threadId }),
          command,
        };
        const deferred = yield* Deferred.make<unknown, WireError>();
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
        return payload as TPayload;
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
      listThreads: () =>
        request<SessionResponse<"list_threads">>(ListThreadsCommand.make({})).pipe(Effect.map((p) => [...p.threads])),
      createThread: (name, options) =>
        request<SessionResponse<"create_thread">>(CreateThreadCommand.make({ name, ...options })).pipe(
          Effect.map((p) => p.thread),
        ),
      getThread: (threadId) =>
        request<SessionResponse<"get_thread">>(GetThreadCommand.make({ threadId })).pipe(Effect.map((p) => p.thread)),
      renameThread: (threadId, name) =>
        request<SessionResponse<"rename_thread">>(RenameThreadCommand.make({ threadId, name })).pipe(
          Effect.map((p) => p.thread),
        ),
      deleteThread: (threadId) => request(DeleteThreadCommand.make({ threadId })).pipe(Effect.asVoid),
      // -- session commands
      prompt: (threadId, text, images) => request(PromptCommand.make({ text, images }), threadId).pipe(Effect.asVoid),
      steer: (threadId, text) => request(SteerCommand.make({ text }), threadId).pipe(Effect.asVoid),
      followUp: (threadId, text) => request(FollowUpCommand.make({ text }), threadId).pipe(Effect.asVoid),
      abort: (threadId) => request(AbortCommand.make({}), threadId).pipe(Effect.asVoid),
      setSteeringMode: (threadId, mode) => request(SetSteeringModeCommand.make({ mode }), threadId).pipe(Effect.asVoid),
      setFollowUpMode: (threadId, mode) => request(SetFollowUpModeCommand.make({ mode }), threadId).pipe(Effect.asVoid),
      compact: (threadId, customInstructions) =>
        request<SessionResponse<"compact">>(CompactCommand.make({ customInstructions }), threadId).pipe(
          Effect.map((p) => p.result as CompactResult),
        ),
      setAutoCompaction: (threadId, enabled) =>
        request(SetAutoCompactionCommand.make({ enabled }), threadId).pipe(Effect.asVoid),
      getAvailableModels: (threadId) =>
        request<SessionResponse<"get_available_models">>(GetAvailableModelsCommand.make({}), threadId).pipe(
          Effect.map((p) => [...p.models]),
        ),
      setModel: (threadId, provider, modelId) =>
        request<SessionResponse<"set_model">>(SetModelCommand.make({ provider, modelId }), threadId).pipe(
          Effect.map((p) => p.model),
        ),
      getAvailableThinkingLevels: (threadId) =>
        request<SessionResponse<"get_available_thinking_levels">>(GetAvailableThinkingLevelsCommand.make({}), threadId).pipe(
          Effect.map((p) => [...p.levels]),
        ),
      setThinkingLevel: (threadId, level) =>
        request<SessionResponse<"set_thinking_level">>(SetThinkingLevelCommand.make({ level }), threadId).pipe(
          Effect.map((p) => p.level),
        ),
      getEntries: (threadId, sinceSeq) =>
        request<SessionResponse<"get_entries">>(GetEntriesCommand.make({ sinceSeq }), threadId).pipe(
          Effect.map((p) => ({ entries: [...p.entries] as Entry[], tailSeq: p.tailSeq, leafId: p.leafId })),
        ),
      branch: (threadId, entryId) =>
        request<SessionResponse<"branch">>(BranchCommand.make({ entryId }), threadId).pipe(Effect.map((p) => p.leafId)),
      getSessionStats: (threadId) =>
        request<SessionResponse<"get_session_stats">>(GetSessionStatsCommand.make({}), threadId).pipe(
          Effect.map((p) => p.stats as SessionStats),
        ),
      setSessionName: (threadId, name) => request(SetSessionNameCommand.make({ name }), threadId).pipe(Effect.asVoid),
      getState: (threadId) =>
        request<SessionResponse<"get_state">>(GetStateCommand.make({}), threadId).pipe(Effect.map((p) => p.state)),
      // -- skills commands
      listSkills: () =>
        request<SessionResponse<"list_skills">>(ListSkillsCommand.make({})).pipe(Effect.map((p) => [...p.skills])),
      importSkill: (source, scope) =>
        request<SessionResponse<"import_skill">>(ImportSkillCommand.make({ source, scope })).pipe(
          Effect.map((p) => p.skill),
        ),
      deleteSkill: (id) => request(DeleteSkillCommand.make({ id })).pipe(Effect.asVoid),
    };
  });
