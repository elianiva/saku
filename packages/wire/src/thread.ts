/**
 * The wire's thread feature: the registry layer pi lacks.
 *
 * Consoles list, create, get, and delete threads; every mutation is
 * broadcast to all consoles as a `thread_changed` event (stateless routing —
 * there is no attach/detach; every console sees every thread).
 */

import { Schema as S } from "effect";

/** A thread's hands policy. Hard-pinned at creation (CONTEXT.md: Mode). */
export const ThreadMode = S.Literals(["local", "sandbox", "any"]);
export type ThreadMode = S.Schema.Type<typeof ThreadMode>;

/**
 * A thread's lifecycle state (CONTEXT.md: Thread). Derived by the worker;
 * consoles never compute it.
 *
 * - `idle` — session host alive, no run in flight
 * - `working` — a run is in flight (agent_start → settled)
 * - `crashed` — the session host faulted; history intact on disk
 * - `interrupted` — the daemon died mid-run; an operation is left open
 */
export const ThreadState = S.Literals(["idle", "working", "crashed", "interrupted"]);
export type ThreadState = S.Schema.Type<typeof ThreadState>;

/** Registry view of a thread, broadcast on every mutation. */
export const ThreadInfo = S.Struct({
  id: S.String,
  name: S.String,
  cwd: S.String,
  mode: ThreadMode,
  state: ThreadState,
  /** Pi session id (stable across daemon restarts); null before first touch. */
  sessionId: S.Union([S.Null, S.String]),
  /** Highest durable-log sequence the thread has reached. */
  tailSeq: S.Number,
});
export type ThreadInfo = S.Schema.Type<typeof ThreadInfo>;

/** Registry ops: the control-plane layer pi doesn't have. */
export const ThreadCommand = S.Union([
  S.TaggedStruct("list_threads", {}),
  S.TaggedStruct("create_thread", {
    name: S.String,
    cwd: S.String,
    mode: S.optional(ThreadMode),
  }),
  S.TaggedStruct("get_thread", {
    threadId: S.String,
  }),
  S.TaggedStruct("delete_thread", {
    threadId: S.String,
  }),
]);
export type ThreadCommand = S.Schema.Type<typeof ThreadCommand>;

/** Broadcast registry mutation (worker → console). */
export const ThreadChanged = S.TaggedStruct("thread_changed", {
  thread: ThreadInfo,
});
export type ThreadChanged = S.Schema.Type<typeof ThreadChanged>;

/** First N characters of the thread id — the human-facing short id. */
export const shortThreadId = (id: string, length = 8): string => id.slice(0, length);

/** Resolve a user-supplied prefix/name against a thread list (git-style). */
export const resolveThread = (
  threads: readonly ThreadInfo[],
  input: string,
): { readonly ok: true; readonly thread: ThreadInfo } | { readonly ok: false; readonly message: string } => {
  const exactName = threads.find((t) => t.name === input);
  if (exactName) return { ok: true, thread: exactName };
  const matches = threads.filter((t) => t.id.startsWith(input));
  if (matches.length === 1) {
    const only = matches[0];
    if (only !== undefined) return { ok: true, thread: only };
  }
  if (matches.length === 0) {
    return { ok: false, message: `no thread matches "${input}"` };
  }
  return {
    ok: false,
    message: `"${input}" is ambiguous: ${matches.map((t) => `${shortThreadId(t.id)} (${t.name})`).join(", ")}`,
  };
};
