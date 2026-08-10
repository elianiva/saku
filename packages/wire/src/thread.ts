/**
 * The wire's thread feature: the registry layer pi lacks.
 *
 * Consoles list, create, get, and delete threads; every mutation is
 * broadcast to all consoles as a `thread_changed` event (stateless routing —
 * there is no attach/detach; every console sees every thread).
 */

import { Result, Schema as S } from "effect";

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

export const ListThreadsCommand = S.TaggedStruct("list_threads", {});
export const CreateThreadCommand = S.TaggedStruct("create_thread", {
  name: S.String,
  cwd: S.String,
  mode: S.optional(ThreadMode),
  /** The name is an auto-generated prompt snippet, not a user choice (CONTEXT.md: Quick start). */
  autoName: S.optional(S.Boolean),
});
export const GetThreadCommand = S.TaggedStruct("get_thread", {
  threadId: S.String,
});
export const DeleteThreadCommand = S.TaggedStruct("delete_thread", {
  threadId: S.String,
});
/** Rename the registry record — the visible thread name (CONTEXT.md: Auto-title). */
export const RenameThreadCommand = S.TaggedStruct("rename_thread", {
  threadId: S.String,
  name: S.String,
});

export const ThreadCommand = S.Union([
  ListThreadsCommand,
  CreateThreadCommand,
  GetThreadCommand,
  DeleteThreadCommand,
  RenameThreadCommand,
]);
export type ThreadCommand = S.Schema.Type<typeof ThreadCommand>;

/** Broadcast registry mutation (worker → console). */
export const ThreadChanged = S.TaggedStruct("thread_changed", {
  thread: ThreadInfo,
});
export type ThreadChanged = S.Schema.Type<typeof ThreadChanged>;

/** First N characters of the thread id — the human-facing short id. */
export const shortThreadId = (id: string, length = 8): string => id.slice(0, length);

/**
 * Resolve a user-supplied prefix/name against a thread list (git-style).
 * `Failure` carries the user-facing message.
 */
export const resolveThread = <T extends { readonly id: string; readonly name: string }>(
  threads: readonly T[],
  input: string,
): Result.Result<T, string> => {
  const exactName = threads.find((t) => t.name === input);
  if (exactName !== undefined) return Result.succeed(exactName);
  const matches = threads.filter((t) => t.id.startsWith(input));
  if (matches.length === 1 && matches[0] !== undefined) {
    return Result.succeed(matches[0]);
  }
  if (matches.length === 0) {
    return Result.fail(`no thread matches "${input}"`);
  }
  return Result.fail(
    `"${input}" is ambiguous: ${matches.map((t) => `${shortThreadId(t.id)} (${t.name})`).join(", ")}`,
  );
};
