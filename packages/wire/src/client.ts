/**
 * The wire's client feature: `WorkerClient`, the console's connection to the
 * worker. Comparable to pi's `RpcClient`, but socket-based and thread-scoped.
 *
 * - Effect-typed commands, correlated by request id (pending requests are
 *   `Deferred`s in a `Ref`, resolved by the incoming event stream)
 * - typed callback subscriptions for streamed events (foldkit-friendly)
 * - optional reconnect with exponential backoff; on reconnect the console
 *   catches up via `get_entries(since tailSeq)` (no server-side replay)
 *
 * `connect` completes the handshake and returns the worker's `HelloOk`;
 * `disconnect` is an Effect so the connection composes as a scoped resource
 * (`Effect.acquireRelease(connect(), (client) => client.disconnect())`).
 * Socket events are plain callbacks that fork Effects into the runtime; all
 * state that crosses the event boundary lives in `Ref`s (the same boundary
 * lutra's `ImageEncoderWorkerLive` draws).
 */

import { createConnection, type Socket } from "node:net";
import { Cause, Deferred, Effect, Ref, Result, Schedule, Schema } from "effect";
import type {
  AgentMessage,
  CompactResult,
  Entry,
  SessionStats,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";

import { Hello, HelloOk } from "./hello.ts";
import { ErrorEvent, SessionEnvelope, ThreadEnvelope, WireCommand, WireEvent } from "./envelope.ts";
import { JsonLinesReader, parseJsonLine, writeJsonLine } from "./transport.ts";
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
  CycleModelCommand,
  CycleThinkingLevelCommand,
  FollowUpCommand,
  GetAvailableModelsCommand,
  GetAvailableThinkingLevelsCommand,
  GetEntriesCommand,
  GetLastAssistantTextCommand,
  GetMessagesCommand,
  GetSessionStatsCommand,
  GetStateCommand,
  GetTreeCommand,
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
  WireTree,
} from "./session.ts";

export class WireError extends Schema.TaggedError<WireError>()("WireError", {
  code: Schema.Literals([
    "disconnected",
    "handshake",
    "timeout",
    "decode",
    "refused",
    "rejected",
    "unknown_thread",
    "crashed_thread",
    "command_failed",
  ]),
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export interface WorkerClientOptions {
  readonly socketPath: string;
  readonly token: string;
  readonly role: "cli";
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
  /** Handshake reply (fires on `connect`/`start`). */
  readonly hello_ok: HelloOk;
  /** Connection-level failure (malformed input, worker error). */
  readonly error: { readonly message: string };
  /** The socket closed. */
  readonly close: undefined;
}
export type ClientEventKind = keyof ClientEvents;

const DECODE = Schema.decodeUnknownSync(WireEvent);
const DECODE_HELLO = Schema.decodeUnknownSync(Schema.Union([HelloOk, ErrorEvent]));

/** Correlate a request id with the deferred that awaits its response. */
type Pending = ReadonlyMap<string, Deferred.Deferred<unknown, WireError>>;

/** Open a unix socket; fails with `refused` when nothing listens there. */
const connectSocket = (socketPath: string): Effect.Effect<Socket, WireError, never> =>
  Effect.callback<Socket, WireError>((resume) => {
    const socket = createConnection(socketPath);
    const onError = (error: Error): void => {
      cleanup();
      const code = (error as NodeJS.ErrnoException).code;
      resume(
        Effect.fail(
          new WireError({
            code: code === "ENOENT" || code === "ECONNREFUSED" ? "refused" : "disconnected",
            message: error.message,
          }),
        ),
      );
    };
    const onConnect = (): void => {
      cleanup();
      resume(Effect.succeed(socket));
    };
    const onClose = (): void => {
      cleanup();
      resume(Effect.fail(new WireError({ code: "disconnected", message: "socket closed before connect" })));
    };
    const cleanup = (): void => {
      socket.off("error", onError);
      socket.off("connect", onConnect);
      socket.off("close", onClose);
    };
    socket.on("error", onError);
    socket.on("connect", onConnect);
    socket.on("close", onClose);
    return Effect.sync(() => socket.destroy());
  });

/**
 * A console's connection to the worker. Create once per process; commands are
 * thread-scoped, events arrive on subscriptions.
 */
export class WorkerClient {
  readonly socketPath: string;
  readonly role: "cli";
  private readonly token: string;
  private readonly reconnectEnabled: boolean;
  private readonly requestTimeoutMs: number;
  private readonly pendingRef: Ref.Ref<Pending>;

  private socket: Socket | null = null;
  private connected = false;
  private requestSeq = 0;
  private readonly listeners = new Map<ClientEventKind, Set<(payload: never) => void>>();

  constructor(options: WorkerClientOptions) {
    this.socketPath = options.socketPath;
    this.token = options.token;
    this.role = options.role;
    this.reconnectEnabled = options.reconnect ?? false;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.pendingRef = Ref.makeUnsafe<Pending>(new Map());
  }

  // -- subscriptions ---------------------------------------------------------

  on<K extends ClientEventKind>(kind: K, listener: (payload: ClientEvents[K]) => void): () => void {
    let set = this.listeners.get(kind);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(kind, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  private emit<K extends ClientEventKind>(kind: K, payload: ClientEvents[K]): void {
    const listeners = this.listeners.get(kind);
    if (listeners === undefined) return;
    for (const listener of listeners) {
      const result = Result.try(() => (listener as (payload: ClientEvents[K]) => void)(payload));
      if (Result.isFailure(result)) {
        console.error("[wire] listener failed:", result.failure);
      }
    }
  }

  get isConnected(): boolean {
    return this.connected;
  }

  // -- lifecycle -------------------------------------------------------------

  /**
   * Connect once and complete the handshake, returning the worker's reply.
   * Fails with `refused` when no daemon is listening, `handshake` when the
   * token is rejected.
   */
  connect(): Effect.Effect<HelloOk, WireError, never> {
    return Effect.gen({ self: this }, function* () {
      const socket = yield* connectSocket(this.socketPath);
      writeJsonLine(socket, Hello.make({ token: this.token, role: this.role }));
      const hello = yield* this.awaitHelloOk(socket);
      this.socket = socket;
      this.connected = true;
      this.attachReader(socket);
      this.emit("hello_ok", hello);
      return hello;
    });
  }

  /** The daemon's handshake reply, decoded by the first `hello_ok`/`error` line. */
  private awaitHelloOk(socket: Socket): Effect.Effect<HelloOk, WireError, never> {
    return Effect.gen(function* () {
      const deferred = yield* Deferred.make<HelloOk, WireError>();
      const reader = new JsonLinesReader((line) => {
        const value = Result.try(() => parseJsonLine(line));
        if (Result.isFailure(value) || value.success === undefined) return;
        const decoded = Result.try(() => DECODE_HELLO(value.success));
        if (Result.isFailure(decoded)) {
          // Not the handshake reply; keep reading.
          return;
        }
        if (decoded.success._tag === "hello_ok") {
          void Effect.runFork(Deferred.succeed(deferred, decoded.success));
        } else {
          void Effect.runFork(
            Deferred.fail(deferred, new WireError({ code: "handshake", message: decoded.success.message })),
          );
        }
      });
      const onData = (chunk: Buffer): void => {
        reader.push(chunk);
      };
      const onError = (error: Error): void => {
        cleanup();
        void Effect.runFork(Deferred.fail(deferred, new WireError({ code: "disconnected", message: error.message })));
      };
      const onClose = (): void => {
        cleanup();
        void Effect.runFork(
          Deferred.fail(deferred, new WireError({ code: "disconnected", message: "socket closed during handshake" })),
        );
      };
      const cleanup = (): void => {
        socket.off("data", onData);
        socket.off("error", onError);
        socket.off("close", onClose);
      };
      socket.on("data", onData);
      socket.on("error", onError);
      socket.on("close", onClose);
      return yield* Effect.ensuring(Deferred.await(deferred), Effect.sync(cleanup));
    });
  }

  private attachReader(socket: Socket): void {
    const reader = new JsonLinesReader((line) => {
      const value = Result.try(() => parseJsonLine(line));
      if (Result.isFailure(value)) {
        this.emit("error", { message: "malformed JSON line from worker" });
        return;
      }
      const decoded = Result.try(() => DECODE(value.success));
      if (Result.isFailure(decoded)) {
        this.emit("error", { message: `undecodable wire event: ${String(decoded.failure)}` });
        return;
      }
      void Effect.runFork(this.handleWireEvent(decoded.success));
    });
    const onData = (chunk: Buffer): void => {
      reader.push(chunk);
    };
    const onClose = (): void => {
      socket.off("data", onData);
      socket.off("close", onClose);
      if (this.connected) {
        this.connected = false;
        void Effect.runFork(this.failAllPending(new WireError({ code: "disconnected", message: "connection closed" })));
      }
      this.emit("close", undefined);
    };
    socket.on("data", onData);
    socket.on("close", onClose);
  }

  /**
   * Connect, then keep reconnecting with backoff after unexpected closes
   * (daemon restart). Handshake rejections fail through — a bad token must
   * not spin forever.
   */
  start(): Effect.Effect<void, WireError, never> {
    const attempt = (): Effect.Effect<void, WireError, never> =>
      this.connect().pipe(Effect.flatMap(() => this.waitForClose()));
    if (!this.reconnectEnabled) {
      return attempt();
    }
    return attempt().pipe(
      Effect.catchIf(
        (error) => error.code === "handshake",
        (error) => Effect.fail(error),
      ),
      Effect.retry(Schedule.exponential("200 millis", 2)),
    );
  }

  /** Fail when the current connection closes — what the reconnect loop retries. */
  private waitForClose(): Effect.Effect<void, WireError, never> {
    return Effect.callback<void, WireError>((resume) => {
      const socket = this.socket;
      if (socket === null) {
        resume(Effect.fail(new WireError({ code: "disconnected", message: "connection closed" })));
        return;
      }
      const onClose = (): void => {
        resume(Effect.fail(new WireError({ code: "disconnected", message: "connection closed" })));
      };
      socket.once("close", onClose);
      return Effect.sync(() => socket.off("close", onClose));
    });
  }

  /** Close the connection; pending commands fail with `disconnected`. */
  disconnect(): Effect.Effect<void, never> {
    return Effect.gen({ self: this }, function* () {
      this.connected = false;
      yield* this.failAllPending(new WireError({ code: "disconnected", message: "client disconnected" }));
      if (this.socket !== null) {
        this.socket.destroy();
        this.socket = null;
      }
    });
  }

  // -- incoming --------------------------------------------------------------

  private handleWireEvent(event: WireEvent): Effect.Effect<void, never> {
    switch (event._tag) {
      case "response":
        // Remove the pending entry first: a late response for an abandoned
        // request (timed out, disconnected) is simply ignored.
        return Ref.getAndUpdate(this.pendingRef, (pending) => {
          const next = new Map(pending);
          next.delete(event.id);
          return next;
        }).pipe(
          Effect.flatMap((pending) => {
            const deferred = pending.get(event.id);
            if (deferred === undefined) return Effect.void;
            if (event.ok) return Deferred.succeed(deferred, event.payload);
            return Deferred.fail(deferred, new WireError({ code: "command_failed", message: event.error }));
          }),
        );
      case "event":
        // The envelope's event payload is opaque JSON by design (ADR 0001:
        // pi's event vocabulary crosses the wire unvalidated); the console
        // narrows it to the projected `SessionWireEvent` at this boundary.
        return Effect.sync(() => this.emit("event", { threadId: event.threadId, event: event.event as SessionWireEvent }));
      case "thread_changed":
        return Effect.sync(() => this.emit("thread_changed", event.thread));
      case "hello_ok":
        return Effect.sync(() => this.emit("hello_ok", event));
      case "error":
        return Effect.sync(() => this.emit("error", { message: event.message }));
    }
  }

  /** Fail every in-flight request; the pending map is drained. */
  private failAllPending(error: WireError): Effect.Effect<void, never> {
    return Ref.getAndSet(this.pendingRef, new Map()).pipe(
      Effect.flatMap((pending) =>
        Effect.forEach(pending, ([, deferred]) => Deferred.fail(deferred, error), { discard: true }),
      ),
    );
  }

  // -- commands --------------------------------------------------------------

  private nextRequestId(): string {
    return `req_${++this.requestSeq}`;
  }

  /** Send a session-scoped command and await its correlated response. */
  private request<TPayload extends ResponsePayload>(
    command: SessionCommand,
    threadId: string,
  ): Effect.Effect<TPayload, WireError, never> {
    return this.send({ ...SessionEnvelope.make({ threadId, command }), id: this.nextRequestId() });
  }

  /** Send a registry (thread) command and await its correlated response. */
  private requestThread<TPayload extends ResponsePayload>(
    command: ThreadCommand,
  ): Effect.Effect<TPayload, WireError, never> {
    return this.send({ ...ThreadEnvelope.make({ command }), id: this.nextRequestId() });
  }

  /**
   * This client always correlates by request id; the schema's optional `id`
   * exists for foreign writers, not for us.
   */
  private send<TPayload extends ResponsePayload>(
    envelope: WireCommand & { readonly id: string },
  ): Effect.Effect<TPayload, WireError, never> {
    return Effect.gen({ self: this }, function* () {
      if (!this.connected || this.socket === null) {
        return yield* Effect.fail(new WireError({ code: "disconnected", message: "not connected" }));
      }
      const socket = this.socket;
      const deferred = yield* Deferred.make<unknown, WireError>();
      yield* Ref.update(this.pendingRef, (pending) => new Map(pending).set(envelope.id, deferred));
      writeJsonLine(socket, envelope);
      const payload = yield* Effect.ensuring(
        Deferred.await(deferred).pipe(
          Effect.timeout(this.requestTimeoutMs),
          Effect.mapError((error) =>
            Cause.isTimeoutError(error)
              ? new WireError({ code: "timeout", message: `command ${envelope.id} timed out` })
              : error,
          ),
        ),
        // The response handler already removed the entry on success; this
        // covers timeout and interruption.
        Ref.update(this.pendingRef, (pending) => {
          const next = new Map(pending);
          next.delete(envelope.id);
          return next;
        }),
      );
      return payload as TPayload;
    });
  }

  // -- session commands ------------------------------------------------------

  prompt(threadId: string, text: string, images?: ReadonlyArray<unknown>): Effect.Effect<void, WireError, never> {
    return this.request(PromptCommand.make({ text, images }), threadId).pipe(Effect.asVoid);
  }

  steer(threadId: string, text: string): Effect.Effect<void, WireError, never> {
    return this.request(SteerCommand.make({ text }), threadId).pipe(Effect.asVoid);
  }

  followUp(threadId: string, text: string): Effect.Effect<void, WireError, never> {
    return this.request(FollowUpCommand.make({ text }), threadId).pipe(Effect.asVoid);
  }

  abort(threadId: string): Effect.Effect<void, WireError, never> {
    return this.request(AbortCommand.make({}), threadId).pipe(Effect.asVoid);
  }

  setSteeringMode(threadId: string, mode: "all" | "one-at-a-time"): Effect.Effect<void, WireError, never> {
    return this.request(SetSteeringModeCommand.make({ mode }), threadId).pipe(Effect.asVoid);
  }

  setFollowUpMode(threadId: string, mode: "all" | "one-at-a-time"): Effect.Effect<void, WireError, never> {
    return this.request(SetFollowUpModeCommand.make({ mode }), threadId).pipe(Effect.asVoid);
  }

  getMessages(threadId: string): Effect.Effect<AgentMessage[], WireError, never> {
    return this.request<SessionResponse<"get_messages">>(GetMessagesCommand.make({}), threadId).pipe(
      Effect.map((p) => [...p.messages] as AgentMessage[]),
    );
  }

  getLastAssistantText(threadId: string): Effect.Effect<string | null, WireError, never> {
    return this.request<SessionResponse<"get_last_assistant_text">>(GetLastAssistantTextCommand.make({}), threadId).pipe(
      Effect.map((p) => p.text),
    );
  }

  compact(threadId: string, customInstructions?: string): Effect.Effect<CompactResult, WireError, never> {
    return this.request<SessionResponse<"compact">>(CompactCommand.make({ customInstructions }), threadId).pipe(
      Effect.map((p) => p.result as CompactResult),
    );
  }

  setAutoCompaction(threadId: string, enabled: boolean): Effect.Effect<void, WireError, never> {
    return this.request(SetAutoCompactionCommand.make({ enabled }), threadId).pipe(Effect.asVoid);
  }

  getAvailableModels(threadId: string): Effect.Effect<WireModelInfo[], WireError, never> {
    return this.request<SessionResponse<"get_available_models">>(GetAvailableModelsCommand.make({}), threadId).pipe(
      Effect.map((p) => [...p.models]),
    );
  }

  setModel(threadId: string, provider: string, modelId: string): Effect.Effect<WireModelInfo | null, WireError, never> {
    return this.request<SessionResponse<"set_model">>(SetModelCommand.make({ provider, modelId }), threadId).pipe(
      Effect.map((p) => p.model),
    );
  }

  cycleModel(threadId: string): Effect.Effect<WireModelInfo | null, WireError, never> {
    return this.request<SessionResponse<"cycle_model">>(CycleModelCommand.make({}), threadId).pipe(
      Effect.map((p) => p.model),
    );
  }

  getAvailableThinkingLevels(threadId: string): Effect.Effect<ThinkingLevel[], WireError, never> {
    return this.request<SessionResponse<"get_available_thinking_levels">>(
      GetAvailableThinkingLevelsCommand.make({}),
      threadId,
    ).pipe(Effect.map((p) => [...p.levels]));
  }

  setThinkingLevel(threadId: string, level: ThinkingLevel): Effect.Effect<ThinkingLevel, WireError, never> {
    return this.request<SessionResponse<"set_thinking_level">>(SetThinkingLevelCommand.make({ level }), threadId).pipe(
      Effect.map((p) => p.level),
    );
  }

  cycleThinkingLevel(threadId: string): Effect.Effect<ThinkingLevel, WireError, never> {
    return this.request<SessionResponse<"cycle_thinking_level">>(CycleThinkingLevelCommand.make({}), threadId).pipe(
      Effect.map((p) => p.level),
    );
  }

  getEntries(
    threadId: string,
    sinceSeq?: number,
  ): Effect.Effect<{ entries: Entry[]; tailSeq: number; leafId: string | null }, WireError, never> {
    return this.request<SessionResponse<"get_entries">>(GetEntriesCommand.make({ sinceSeq }), threadId).pipe(
      Effect.map((p) => ({ entries: [...p.entries] as Entry[], tailSeq: p.tailSeq, leafId: p.leafId })),
    );
  }

  getTree(threadId: string): Effect.Effect<WireTree, WireError, never> {
    return this.request<SessionResponse<"get_tree">>(GetTreeCommand.make({}), threadId).pipe(Effect.map((p) => p.tree));
  }

  /** Move the session's leaf to a past entry (idle threads only). */
  branch(threadId: string, entryId: string): Effect.Effect<string | null, WireError, never> {
    return this.request<SessionResponse<"branch">>(BranchCommand.make({ entryId }), threadId).pipe(
      Effect.map((p) => p.leafId),
    );
  }

  getSessionStats(threadId: string): Effect.Effect<SessionStats, WireError, never> {
    return this.request<SessionResponse<"get_session_stats">>(GetSessionStatsCommand.make({}), threadId).pipe(
      Effect.map((p) => p.stats as SessionStats),
    );
  }

  setSessionName(threadId: string, name: string): Effect.Effect<void, WireError, never> {
    return this.request(SetSessionNameCommand.make({ name }), threadId).pipe(Effect.asVoid);
  }

  getState(threadId: string): Effect.Effect<ThreadSessionState, WireError, never> {
    return this.request<SessionResponse<"get_state">>(GetStateCommand.make({}), threadId).pipe(
      Effect.map((p) => p.state),
    );
  }

  // -- thread commands -------------------------------------------------------

  listThreads(): Effect.Effect<ThreadInfo[], WireError, never> {
    return this.requestThread<SessionResponse<"list_threads">>(ListThreadsCommand.make({})).pipe(
      Effect.map((p) => [...p.threads]),
    );
  }

  createThread(
    name: string,
    cwd: string,
    options?: { readonly mode?: ThreadMode; readonly autoName?: boolean },
  ): Effect.Effect<ThreadInfo, WireError, never> {
    return this.requestThread<SessionResponse<"create_thread">>(
      CreateThreadCommand.make({ name, cwd, ...options }),
    ).pipe(Effect.map((p) => p.thread));
  }

  getThread(threadId: string): Effect.Effect<ThreadInfo, WireError, never> {
    return this.requestThread<SessionResponse<"get_thread">>(GetThreadCommand.make({ threadId })).pipe(
      Effect.map((p) => p.thread),
    );
  }

  renameThread(threadId: string, name: string): Effect.Effect<ThreadInfo, WireError, never> {
    return this.requestThread<SessionResponse<"rename_thread">>(RenameThreadCommand.make({ threadId, name })).pipe(
      Effect.map((p) => p.thread),
    );
  }

  deleteThread(threadId: string): Effect.Effect<void, WireError, never> {
    return this.requestThread(DeleteThreadCommand.make({ threadId })).pipe(Effect.asVoid);
  }
}
