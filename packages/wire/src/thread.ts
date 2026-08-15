/**
 * The wire's thread feature: the registry layer pi lacks.
 *
 * Consoles list, create, get, and delete threads; every mutation is
 * broadcast to all consoles as a `thread_changed` event (stateless routing —
 * there is no attach/detach; every console sees every thread).
 *
 * Lifecycle: the thread state and the env state are separate axes — a
 * thread can be `working` while its Box is `ready`, or `idle` while the Box
 * is `stopped` (idle-stop; the next prompt provisions it again).
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
 * - `interrupted` — the worker died mid-run; an operation is left open and
 *   recovery happens on the next command
 *
 * `crashed` is gone: a failed run is an error response, and the next command
 * rebuilds from the entry trail.
 */
export const ThreadState = S.Literals(["idle", "working", "interrupted"]);
export type ThreadState = S.Schema.Type<typeof ThreadState>;

/**
 * The env axis of a thread (CONTEXT.md: Env): where its hands live and
 * whether they answer.
 *
 * - `stopped` — env exists but is not running (idle-stop, or the local
 *   daemon is not registered)
 * - `provisioning` — a Box is being created/resumed right now
 * - `ready` — the env answers (a run can proceed)
 * - `error` — provisioning failed; the next prompt retries
 */
export const ThreadEnvState = S.Literals(["stopped", "provisioning", "ready", "error"]);
export type ThreadEnvState = S.Schema.Type<typeof ThreadEnvState>;

/**
 * Where a thread's session came from. Present only on adopted threads
 * (imported pi sessions); provenance makes re-import idempotent and
 * delete semantics explicit (removing a thread never touches the source).
 */
export const ThreadSource = S.Struct({
  kind: S.Literal("pi"),
  /** The pi session id (the file header's id). */
  sessionId: S.String,
  /** The pi session file this thread was adopted from. */
  path: S.String,
});
export type ThreadSource = S.Schema.Type<typeof ThreadSource>;

/** Registry view of a thread, broadcast on every mutation. */
export const ThreadInfo = S.Struct({
  id: S.String,
  name: S.String,
  /** The working directory the thread was created with; null for sandbox threads. */
  cwd: S.Union([S.Null, S.String]),
  mode: ThreadMode,
  state: ThreadState,
  env: ThreadEnvState,
  /** Pi session id (stable across restarts); null before first touch. */
  sessionId: S.Union([S.Null, S.String]),
  /** Highest durable-log sequence the thread has reached. */
  tailSeq: S.Number,
  /** Adopted-thread provenance; absent on threads created from scratch. */
  source: S.optional(ThreadSource),
  /** Archive visibility lifecycle (CONTEXT.md: Archive); null when active. */
  archivedAt: S.Union([S.Null, S.Number]),
});
export type ThreadInfo = S.Schema.Type<typeof ThreadInfo>;

export const ListThreadsCommand = S.TaggedStruct("list_threads", {});
export const CreateThreadCommand = S.TaggedStruct("create_thread", {
  name: S.String,
  /** Local-only: the working directory on the local machine (ADR 0003). */
  cwd: S.optional(S.String),
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
/** Archive a thread: visibility-only, the trail is untouched (CONTEXT.md: Archive). */
export const ArchiveThreadCommand = S.TaggedStruct("archive_thread", {
  threadId: S.String,
});
/** Unarchive a thread: back to the active list, nothing else changes. */
export const UnarchiveThreadCommand = S.TaggedStruct("unarchive_thread", {
  threadId: S.String,
});

export const ThreadCommand = S.Union([
  ListThreadsCommand,
  CreateThreadCommand,
  GetThreadCommand,
  DeleteThreadCommand,
  RenameThreadCommand,
  ArchiveThreadCommand,
  UnarchiveThreadCommand,
]);
export type ThreadCommand = S.Schema.Type<typeof ThreadCommand>;

/** Broadcast registry mutation (server → console). */
export const ThreadChanged = S.TaggedStruct("thread_changed", {
  thread: ThreadInfo,
});
export type ThreadChanged = S.Schema.Type<typeof ThreadChanged>;

/** First N characters of the thread id — the human-facing short id. */
export const shortThreadId = (id: string, length = 8) => id.slice(0, length);

/**
 * Resolve a user-supplied prefix/name against a thread list (git-style).
 * `Failure` carries the user-facing message.
 */
export const resolveThread = <T extends { readonly id: string; readonly name: string }>(
  threads: readonly T[],
  input: string,
) => {
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
