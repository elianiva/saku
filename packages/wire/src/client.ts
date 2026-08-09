/**
 * The wire's client feature: `WorkerClient`, the console's connection to the
 * worker. Comparable to pi's `RpcClient`, but socket-based and thread-scoped.
 *
 * - Effect-typed commands, correlated by request id, with timeouts
 * - callback subscriptions for streamed events (foldkit-friendly)
 * - optional reconnect with exponential backoff; on reconnect the console
 *   catches up via `get_entries(since tailSeq)` (no server-side replay)
 */

import { createConnection, type Socket } from "node:net";
import { Effect, Schedule, Schema } from "effect";
import type {
  AgentMessage,
  CompactResult,
  Entry,
  SessionStats,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";

import { HelloError, HelloOk } from "./hello.ts";
import { JsonLinesReader, parseJsonLine, writeJsonLine } from "./transport.ts";
import { ThreadCommand, ThreadInfo, type ThreadMode } from "./thread.ts";
import {
  ResponsePayload,
  SessionCommand,
  type SessionWireEvent,
  ThreadSessionState,
  WireModelInfo,
  WireTree,
} from "./session.ts";
import { WireCommand, WireEvent } from "./envelope.ts";

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
}) {}

export interface WorkerClientOptions {
  readonly socketPath: string;
  readonly token: string;
  readonly role: "tui" | "cli";
  /** Reconnect with backoff after unexpected disconnects. Default: false. */
  readonly reconnect?: boolean;
  /** Per-command timeout. Default: 30s (pi's RpcClient habit). */
  readonly requestTimeoutMs?: number;
}

export type ClientEventKind = "event" | "thread_changed" | "hello_ok" | "error" | "close";
export type ClientEventListener = (payload: unknown) => void;

const DECODE = Schema.decodeUnknownSync(WireEvent);
const DECODE_HELLO = Schema.decodeUnknownSync(Schema.Union([HelloOk, HelloError]));

interface PendingRequest {
  readonly resume: (result: Effect.Effect<unknown, WireError, never>) => void;
  readonly timer: NodeJS.Timeout;
}

/**
 * A console's connection to the worker. Create once per process; commands are
 * thread-scoped, events arrive on subscriptions.
 */
export class WorkerClient {
  readonly socketPath: string;
  readonly role: "tui" | "cli";
  private readonly token: string;
  private readonly reconnectEnabled: boolean;
  private readonly requestTimeoutMs: number;

  private socket: Socket | null = null;
  private connected = false;
  private requestSeq = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Map<ClientEventKind, Set<ClientEventListener>>();

  constructor(options: WorkerClientOptions) {
    this.socketPath = options.socketPath;
    this.token = options.token;
    this.role = options.role;
    this.reconnectEnabled = options.reconnect ?? false;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  // -- subscriptions ---------------------------------------------------------

  on(kind: ClientEventKind, listener: ClientEventListener): () => void {
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

  private emit(kind: ClientEventKind, payload: unknown): void {
    for (const listener of this.listeners.get(kind) ?? []) {
      try {
        listener(payload);
      } catch (error) {
        console.error("[wire] listener failed:", error);
      }
    }
  }

  get isConnected(): boolean {
    return this.connected;
  }

  // -- lifecycle -------------------------------------------------------------

  /**
   * Connect once and complete the handshake. Fails with `refused` when no
   * daemon is listening, `handshake` when the token is rejected.
   */
  connect(): Effect.Effect<void, WireError, never> {
    return Effect.callback<Socket, WireError>((resume) => {
      const socket = createConnection(this.socketPath);
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
        writeJsonLine(socket, { _tag: "hello", token: this.token, role: this.role });
        resume(Effect.succeed(socket));
      };
      const onClose = (): void => {
        cleanup();
        resume(Effect.fail(new WireError({ code: "disconnected", message: "socket closed before handshake" })));
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
    }).pipe(
      Effect.flatMap((socket) => this.awaitHelloOk(socket)),
      Effect.map(({ socket, hello }) => {
        this.socket = socket;
        this.connected = true;
        this.attachReader(socket);
        this.emit("hello_ok", hello);
      }),
    );
  }

  private awaitHelloOk(
    socket: Socket,
  ): Effect.Effect<{ readonly socket: Socket; readonly hello: HelloOk }, WireError, never> {
    return Effect.callback<{ readonly socket: Socket; readonly hello: HelloOk }, WireError>((resume) => {
      let settled = false;
      const reader = new JsonLinesReader((line) => {
        if (settled) return;
        let value: unknown;
        try {
          value = parseJsonLine(line);
        } catch {
          return;
        }
        if (value === undefined) return;
        let decoded: unknown;
        try {
          decoded = DECODE_HELLO(value);
        } catch {
          return;
        }
        settled = true;
        cleanup();
        const tagged = decoded as { _tag: string };
        if (tagged._tag === "hello_ok") {
          resume(Effect.succeed({ socket, hello: decoded as HelloOk }));
        } else {
          const error = decoded as HelloError;
          resume(Effect.fail(new WireError({ code: "handshake", message: error.message })));
        }
      });
      const onData = (chunk: Buffer): void => {
        reader.push(chunk);
      };
      const onError = (error: Error): void => {
        cleanup();
        resume(Effect.fail(new WireError({ code: "disconnected", message: error.message })));
      };
      const onClose = (): void => {
        cleanup();
        if (!settled) {
          resume(Effect.fail(new WireError({ code: "disconnected", message: "socket closed during handshake" })));
        }
      };
      const cleanup = (): void => {
        socket.off("data", onData);
        socket.off("error", onError);
        socket.off("close", onClose);
      };
      socket.on("data", onData);
      socket.on("error", onError);
      socket.on("close", onClose);
      return Effect.sync(() => {
        cleanup();
      });
    });
  }

  private attachReader(socket: Socket): void {
    const reader = new JsonLinesReader((line) => {
      let value: unknown;
      try {
        value = parseJsonLine(line);
      } catch {
        this.emit("error", { message: "malformed JSON line from worker" });
        return;
      }
      let decoded: WireEvent;
      try {
        decoded = DECODE(value);
      } catch (error) {
        this.emit("error", { message: `undecodable wire event: ${String(error)}` });
        return;
      }
      this.handleWireEvent(decoded);
    });
    const onData = (chunk: Buffer): void => {
      reader.push(chunk);
    };
    const onClose = (): void => {
      socket.off("data", onData);
      socket.off("close", onClose);
      if (this.connected) {
        this.connected = false;
        this.failAllPending(new WireError({ code: "disconnected", message: "connection closed" }));
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
      Effect.flatMap(this.connect(), () =>
        Effect.callback<void, WireError>((resume) => {
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
        }),
      );
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

  /** Close the connection; pending commands fail with `disconnected`. */
  disconnect(): void {
    this.connected = false;
    this.failAllPending(new WireError({ code: "disconnected", message: "client disconnected" }));
    if (this.socket !== null) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  // -- incoming --------------------------------------------------------------

  private handleWireEvent(event: WireEvent): void {
    switch (event._tag) {
      case "response": {
        const entry = this.pending.get(event.id);
        if (entry === undefined) return;
        this.pending.delete(event.id);
        clearTimeout(entry.timer);
        if (event.ok) {
          entry.resume(Effect.succeed(event.payload));
        } else {
          entry.resume(Effect.fail(new WireError({ code: "command_failed", message: event.error })));
        }
        return;
      }
      case "event":
        this.emit("event", { threadId: event.threadId, event: event.event as SessionWireEvent });
        return;
      case "thread_changed":
        this.emit("thread_changed", event.thread);
        return;
      case "hello_ok":
        this.emit("hello_ok", event);
        return;
      case "error":
        this.emit("error", event);
        return;
    }
  }

  private failAllPending(error: WireError): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.resume(Effect.fail(error));
    }
    this.pending.clear();
  }

  // -- commands --------------------------------------------------------------

  private request<TPayload extends ResponsePayload>(
    command: SessionCommand,
    threadId: string,
  ): Effect.Effect<TPayload, WireError, never>;
  private request<TPayload extends ResponsePayload>(
    command: ThreadCommand,
  ): Effect.Effect<TPayload, WireError, never>;
  private request<TPayload extends ResponsePayload>(
    command: SessionCommand | ThreadCommand,
    threadId?: string,
  ): Effect.Effect<TPayload, WireError, never> {
    const id = `req_${++this.requestSeq}`;
    const envelope: WireCommand =
      threadId === undefined
        ? { _tag: "thread", id, command: command as ThreadCommand }
        : { _tag: "session", id, threadId, command: command as SessionCommand };

    return Effect.callback<TPayload, WireError>((resume) => {
      if (!this.connected || this.socket === null) {
        resume(Effect.fail(new WireError({ code: "disconnected", message: "not connected" })));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resume(Effect.fail(new WireError({ code: "timeout", message: `command ${id} timed out` })));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resume: resume as (result: Effect.Effect<unknown, WireError, never>) => void,
        timer,
      });
      writeJsonLine(this.socket, envelope);
      return Effect.sync(() => {
        this.pending.delete(id);
        clearTimeout(timer);
      });
    });
  }

  // -- session commands ------------------------------------------------------

  prompt(threadId: string, text: string, images?: ReadonlyArray<unknown>): Effect.Effect<void, WireError, never> {
    return this.request(
      images === undefined || images.length === 0
        ? { _tag: "prompt", text }
        : { _tag: "prompt", text, images: [...images] },
      threadId,
    ).pipe(Effect.map(() => undefined));
  }

  steer(threadId: string, text: string): Effect.Effect<void, WireError, never> {
    return this.request({ _tag: "steer", text }, threadId).pipe(Effect.map(() => undefined));
  }

  followUp(threadId: string, text: string): Effect.Effect<void, WireError, never> {
    return this.request({ _tag: "follow_up", text }, threadId).pipe(Effect.map(() => undefined));
  }

  abort(threadId: string): Effect.Effect<void, WireError, never> {
    return this.request({ _tag: "abort" }, threadId).pipe(Effect.map(() => undefined));
  }

  setSteeringMode(threadId: string, mode: "all" | "one-at-a-time"): Effect.Effect<void, WireError, never> {
    return this.request({ _tag: "set_steering_mode", mode }, threadId).pipe(Effect.map(() => undefined));
  }

  setFollowUpMode(threadId: string, mode: "all" | "one-at-a-time"): Effect.Effect<void, WireError, never> {
    return this.request({ _tag: "set_follow_up_mode", mode }, threadId).pipe(Effect.map(() => undefined));
  }

  getMessages(threadId: string): Effect.Effect<AgentMessage[], WireError, never> {
    return this.request<{ _tag: "get_messages"; messages: AgentMessage[] }>({ _tag: "get_messages" }, threadId).pipe(
      Effect.map((p) => p.messages),
    );
  }

  getLastAssistantText(threadId: string): Effect.Effect<string | null, WireError, never> {
    return this.request<{ _tag: "get_last_assistant_text"; text: string | null }>(
      { _tag: "get_last_assistant_text" },
      threadId,
    ).pipe(Effect.map((p) => p.text));
  }

  compact(threadId: string, customInstructions?: string): Effect.Effect<CompactResult, WireError, never> {
    return this.request<{ _tag: "compact"; result: CompactResult }>(
      customInstructions === undefined
        ? { _tag: "compact" }
        : { _tag: "compact", customInstructions },
      threadId,
    ).pipe(Effect.map((p) => p.result));
  }

  setAutoCompaction(threadId: string, enabled: boolean): Effect.Effect<void, WireError, never> {
    return this.request({ _tag: "set_auto_compaction", enabled }, threadId).pipe(Effect.map(() => undefined));
  }

  getAvailableModels(threadId: string): Effect.Effect<WireModelInfo[], WireError, never> {
    return this.request<{ _tag: "get_available_models"; models: WireModelInfo[] }>(
      { _tag: "get_available_models" },
      threadId,
    ).pipe(Effect.map((p) => p.models));
  }

  setModel(threadId: string, provider: string, modelId: string): Effect.Effect<WireModelInfo | null, WireError, never> {
    return this.request<{ _tag: "set_model"; model: WireModelInfo | null }>(
      { _tag: "set_model", provider, modelId },
      threadId,
    ).pipe(Effect.map((p) => p.model));
  }

  cycleModel(threadId: string): Effect.Effect<WireModelInfo | null, WireError, never> {
    return this.request<{ _tag: "cycle_model"; model: WireModelInfo | null }>({ _tag: "cycle_model" }, threadId).pipe(
      Effect.map((p) => p.model),
    );
  }

  getAvailableThinkingLevels(threadId: string): Effect.Effect<ThinkingLevel[], WireError, never> {
    return this.request<{ _tag: "get_available_thinking_levels"; levels: ThinkingLevel[] }>(
      { _tag: "get_available_thinking_levels" },
      threadId,
    ).pipe(Effect.map((p) => p.levels));
  }

  setThinkingLevel(threadId: string, level: ThinkingLevel): Effect.Effect<void, WireError, never> {
    return this.request({ _tag: "set_thinking_level", level }, threadId).pipe(Effect.map(() => undefined));
  }

  cycleThinkingLevel(threadId: string): Effect.Effect<ThinkingLevel, WireError, never> {
    return this.request<{ _tag: "cycle_thinking_level"; level: ThinkingLevel }>(
      { _tag: "cycle_thinking_level" },
      threadId,
    ).pipe(Effect.map((p) => p.level));
  }

  getEntries(
    threadId: string,
    sinceSeq?: number,
  ): Effect.Effect<{ entries: Entry[]; tailSeq: number; leafId: string | null }, WireError, never> {
    return this.request<{ _tag: "get_entries"; entries: Entry[]; tailSeq: number; leafId: string | null }>(
      sinceSeq === undefined ? { _tag: "get_entries" } : { _tag: "get_entries", sinceSeq },
      threadId,
    ).pipe(Effect.map((p) => ({ entries: p.entries, tailSeq: p.tailSeq, leafId: p.leafId })));
  }

  getTree(threadId: string): Effect.Effect<WireTree, WireError, never> {
    return this.request<{ _tag: "get_tree"; tree: WireTree }>({ _tag: "get_tree" }, threadId).pipe(
      Effect.map((p) => p.tree),
    );
  }

  getSessionStats(threadId: string): Effect.Effect<SessionStats, WireError, never> {
    return this.request<{ _tag: "get_session_stats"; stats: SessionStats }>({ _tag: "get_session_stats" }, threadId).pipe(
      Effect.map((p) => p.stats),
    );
  }

  setSessionName(threadId: string, name: string): Effect.Effect<void, WireError, never> {
    return this.request({ _tag: "set_session_name", name }, threadId).pipe(Effect.map(() => undefined));
  }

  getState(threadId: string): Effect.Effect<ThreadSessionState, WireError, never> {
    return this.request<{ _tag: "get_state"; state: ThreadSessionState }>({ _tag: "get_state" }, threadId).pipe(
      Effect.map((p) => p.state),
    );
  }

  // -- thread commands -------------------------------------------------------

  listThreads(): Effect.Effect<ThreadInfo[], WireError, never> {
    return this.request<{ _tag: "list_threads"; threads: ThreadInfo[] }>({ _tag: "list_threads" }).pipe(
      Effect.map((p) => p.threads),
    );
  }

  createThread(name: string, cwd: string, mode?: ThreadMode): Effect.Effect<ThreadInfo, WireError, never> {
    return this.request<{ _tag: "create_thread"; thread: ThreadInfo }>(
      mode === undefined ? { _tag: "create_thread", name, cwd } : { _tag: "create_thread", name, cwd, mode },
    ).pipe(Effect.map((p) => p.thread));
  }

  getThread(threadId: string): Effect.Effect<ThreadInfo, WireError, never> {
    return this.request<{ _tag: "get_thread"; thread: ThreadInfo }>({ _tag: "get_thread", threadId }).pipe(
      Effect.map((p) => p.thread),
    );
  }

  deleteThread(threadId: string): Effect.Effect<void, WireError, never> {
    return this.request({ _tag: "delete_thread", threadId }).pipe(Effect.map(() => undefined));
  }
}
