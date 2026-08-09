/**
 * The TUI's connection hub: owns the `WorkerClient` lifecycle, fans wire
 * events into the TEA loop, and reconnects with catch-up (`get_entries`
 * since the last known tail) after unexpected disconnects.
 *
 * Every method returns an Effect that ALWAYS succeeds with a message — wire
 * failures become `WireError` messages the app surfaces as a dialog — so
 * commands never crash the loop.
 */

import { Effect } from "effect";

import {
  WorkerClient,
  WireError,
  type CompactResult,
  type Entry,
  type SessionWireEvent,
  type ThinkingLevel,
  type ThreadInfo,
  type ThreadSessionState,
  type WireModelInfo,
} from "@saku/wire";
import { getWorkerSocketPath, readAuthToken } from "@saku/worker";

import type { Msg } from "./app.ts";

export interface EntriesResult {
  readonly entries: ReadonlyArray<Entry>;
  readonly tailSeq: number;
  readonly leafId: string | null;
}

/**
 * The quick-start naming rule (CONTEXT.md: Quick start, Auto-title): the
 * prompt's first line, whitespace-collapsed, ~60 chars — the snippet that
 * auto-title later upgrades to `title — snippet`.
 */
export const snippetOf = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "untitled";
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
};

export class WireHub {
  private client: WorkerClient | undefined;
  private readonly dispatch: (message: Msg) => void;
  private reconnecting = false;
  private closed = false;
  private readonly openThreadId: string | null;

  constructor(dispatch: (message: Msg) => void, openThreadId: string | null) {
    this.dispatch = dispatch;
    this.openThreadId = openThreadId;
  }

  /** Tears down the client; the hub no longer reconnects. */
  shutdown(): void {
    this.closed = true;
    this.client?.disconnect();
  }

  // -- connection ------------------------------------------------------------

  private token(): string {
    const token = readAuthToken();
    if (token === undefined) {
      throw new Error("worker auth token missing — start it with: saku daemon start");
    }
    return token;
  }

  private connect(): Effect.Effect<WorkerClient, WireError, never> {
    let token: string;
    try {
      token = this.token();
    } catch (error) {
      return Effect.fail(
        new WireError({ code: "refused", message: (error as Error).message }),
      );
    }
    const client = new WorkerClient({
      socketPath: getWorkerSocketPath(),
      token,
      role: "tui",
    });
    return client.connect().pipe(
      Effect.map(() => {
        this.client = client;
        this.install(client);
        return client;
      }),
    );
  }

  private install(client: WorkerClient): void {
    client.on("event", (payload) => {
      const { threadId, event } = payload as { threadId: string; event: SessionWireEvent };
      this.dispatch({ _tag: "Event", threadId, event });
    });
    client.on("thread_changed", (thread) => {
      this.dispatch({ _tag: "ThreadChanged", thread: thread as ThreadInfo });
    });
    client.on("error", (payload) => {
      const { message } = payload as { message: string };
      this.dispatch({ _tag: "WireError", message: `worker: ${message}` });
    });
    client.on("close", () => {
      this.client = undefined;
      this.dispatch({ _tag: "ConnectionLost" });
      this.scheduleReconnect();
    });
  }

  /** Boot: connect and refresh the thread list. */
  boot(): Effect.Effect<Msg, never, never> {
    const program = this.connect().pipe(Effect.flatMap(() => this.refreshThreads()));
    return Effect.matchEffect(program, {
      onFailure: (error: WireError) =>
        Effect.succeed({
          _tag: "WireError",
          message: `cannot reach the worker: ${error.message}`,
        } satisfies Msg),
      onSuccess: (message) => Effect.succeed(message),
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnecting || this.closed) return;
    this.reconnecting = true;
    const attempt = (n: number): void => {
      if (this.closed) return;
      const delay = Math.min(200 * 2 ** n, 5000);
      setTimeout(() => {
        const program = this.connect().pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              this.reconnecting = false;
            }),
          ),
          Effect.flatMap(() => this.catchUp()),
        );
        void Effect.runPromise(
          Effect.matchEffect(program, {
            onFailure: () => Effect.sync(() => attempt(n + 1)),
            onSuccess: () => Effect.void,
          }),
        );
      }, delay);
    };
    attempt(0);
  }

  /** After a reconnect: refresh the list and re-tail the open thread. */
  private catchUp(): Effect.Effect<Msg, never, never> {
    const refresh = this.refreshThreads();
    if (this.openThreadId === null) return refresh;
    return Effect.all([refresh, this.openThread(this.openThreadId)]).pipe(
      Effect.map(([list]) => list),
    );
  }

  // -- commands --------------------------------------------------------------

  refreshThreads(): Effect.Effect<Msg, never, never> {
    return this.withClient((client) =>
      client.listThreads().pipe(
        Effect.map((threads) => ({ _tag: "Threads", threads } satisfies Msg)),
      ),
    );
  }

  /** Open a thread: durable entries first, then the session state snapshot. */
  openThread(threadId: string): Effect.Effect<Msg, never, never> {
    return this.withClient((client) => this.openThreadWith(client, threadId, false));
  }

  private openThreadWith(
    client: WorkerClient,
    threadId: string,
    started: boolean,
  ): Effect.Effect<Msg, WireError, never> {
    return client.getEntries(threadId).pipe(
      Effect.flatMap(({ entries, tailSeq, leafId }) =>
        client.getState(threadId).pipe(
          Effect.map((state) => ({
            _tag: "ThreadOpened",
            threadId,
            entries,
            tailSeq,
            leafId,
            state,
            started,
          } satisfies Msg)),
        ),
      ),
    );
  }

  private promptWith(client: WorkerClient, threadId: string, text: string): Effect.Effect<Msg, WireError, never> {
    return client.prompt(threadId, text).pipe(Effect.map(() => ({ _tag: "PromptAccepted" } satisfies Msg)));
  }

  /**
   * Quick start (CONTEXT.md: Quick start): create a thread named from the
   * prompt snippet, open it, and fire the prompt — one gesture. The final
   * message is the `ThreadOpened` (with `started`) that switches the screen.
   */
  quickStart(text: string): Effect.Effect<Msg, never, never> {
    return this.withClient((client) =>
      client.createThread(snippetOf(text), process.cwd(), { autoName: true }).pipe(
        Effect.flatMap((thread) =>
          this.openThreadWith(client, thread.id, true).pipe(
            Effect.flatMap((opened) => this.promptWith(client, thread.id, text).pipe(Effect.as(opened))),
          ),
        ),
      ),
    );
  }

  /** Create a named thread and open it (the `n` dialog / `/new`). */
  createAndOpen(name: string, cwd: string): Effect.Effect<Msg, never, never> {
    return this.withClient((client) =>
      client.createThread(name, cwd).pipe(
        Effect.flatMap((thread) => this.openThreadWith(client, thread.id, false)),
      ),
    );
  }

  /** Re-tail after a gap: `get_entries` from the known tail; the app appends
   *  only what is newer than its own tailSeq, so catch-up and live events
   *  never duplicate. */
  catchUpEntries(threadId: string, sinceSeq: number): Effect.Effect<Msg, never, never> {
    return this.withClient((client) =>
      client.getEntries(threadId, sinceSeq).pipe(
        Effect.map(({ entries, tailSeq, leafId }) => ({ _tag: "Entries", threadId, entries, tailSeq, leafId })),
      ),
    );
  }

  sendPrompt(threadId: string, text: string): Effect.Effect<Msg, never, never> {
    return this.withClient((client) => this.promptWith(client, threadId, text));
  }

  abortRun(threadId: string): Effect.Effect<Msg, never, never> {
    return this.withClient((client) =>
      client.abort(threadId).pipe(Effect.map(() => ({ _tag: "Aborted" } satisfies Msg))),
    );
  }

  cycleModel(threadId: string): Effect.Effect<Msg, never, never> {
    return this.withClient((client) =>
      client.cycleModel(threadId).pipe(Effect.map((model) => ({ _tag: "ModelChanged", model }))),
    );
  }

  setModel(threadId: string, provider: string, modelId: string): Effect.Effect<Msg, never, never> {
    return this.withClient((client) =>
      client.setModel(threadId, provider, modelId).pipe(
        Effect.map((model) => ({ _tag: "ModelChanged", model })),
      ),
    );
  }

  cycleThinkingLevel(threadId: string): Effect.Effect<Msg, never, never> {
    return this.withClient((client) =>
      client.cycleThinkingLevel(threadId).pipe(
        Effect.map((level) => ({ _tag: "ThinkingChanged", level })),
      ),
    );
  }

  setThinkingLevel(threadId: string, level: ThinkingLevel): Effect.Effect<Msg, never, never> {
    return this.withClient((client) =>
      client.setThinkingLevel(threadId, level).pipe(
        Effect.map((level) => ({ _tag: "ThinkingChanged", level })),
      ),
    );
  }

  compact(threadId: string): Effect.Effect<Msg, never, never> {
    return this.withClient((client) =>
      client.compact(threadId).pipe(
        Effect.map((result) => ({ _tag: "CompactResult", result: result as CompactResult } satisfies Msg)),
      ),
    );
  }

  renameThread(threadId: string, name: string): Effect.Effect<Msg, never, never> {
    return this.withClient((client) =>
      client.renameThread(threadId, name).pipe(Effect.map(() => ({ _tag: "Renamed" } satisfies Msg))),
    );
  }

  /** Jump the session's leaf to a past entry (the tree overlay). */
  branch(threadId: string, entryId: string): Effect.Effect<Msg, never, never> {
    return this.withClient((client) =>
      client.branch(threadId, entryId).pipe(
        Effect.map((leafId) => ({ _tag: "BranchDone", threadId, leafId })),
      ),
    );
  }

  deleteThread(threadId: string): Effect.Effect<Msg, never, never> {
    return this.withClient((client) =>
      client.deleteThread(threadId).pipe(Effect.map(() => ({ _tag: "Deleted", id: threadId }))),
    );
  }

  /** Refetch the open thread's state (after model/thinking changes). */
  refreshState(threadId: string): Effect.Effect<Msg, never, never> {
    return this.withClient((client) =>
      client.getState(threadId).pipe(
        Effect.map((state) => ({ _tag: "ThreadState", threadId, state })),
      ),
    );
  }

  // -- plumbing --------------------------------------------------------------

  private withClient<M extends Msg>(run: (client: WorkerClient) => Effect.Effect<M, WireError, never>): Effect.Effect<Msg, never, never> {
    const client = this.client;
    if (client === undefined || !client.isConnected) {
      return Effect.succeed({
        _tag: "WireError",
        message: "not connected to the worker",
      } satisfies Msg);
    }
    return Effect.matchEffect(run(client), {
      onFailure: (error: WireError) =>
        Effect.succeed({
          _tag: "WireError",
          message: error.message,
        } satisfies Msg),
      onSuccess: (message) => Effect.succeed(message),
    });
  }
}
