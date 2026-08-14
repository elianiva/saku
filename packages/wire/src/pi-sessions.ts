/**
 * The wire's pi-sessions feature: pi's own session files
 * (`~/.pi/agent/sessions/**`) exposed to consoles through the local daemon.
 *
 * pi's sessions live on the user's machine, so only the local daemon serves
 * these commands — the hub (a DO with no `~/.pi`) rejects them, the mirror
 * of the daemon rejecting hub-only skills commands. Consoles list pi
 * sessions and adopt one as a thread: the daemon parses the pi file (v3 —
 * the format pi's shell writes today, and v4 — pi-agent-core's jsonl
 * format) and replays it into the thread's own trail, after which the
 * thread is a normal thread (single writer, atomic trail — ADR 0005:
 * extend pi, never shim it; import is adoption, not a bridge).
 */

import { Schema as S } from "effect";

import { ThreadInfo } from "./thread.ts";

/**
 * One pi session as the daemon sees it (pi's own `buildSessionInfo` view:
 * name = latest session_info entry including explicit clears, firstMessage
 * = first user message with content).
 */
export const PiSessionInfo = S.Struct({
  id: S.String,
  /** Working directory where the session was started ("" for old sessions). */
  cwd: S.String,
  /** User-defined display name (session_info); absent when never named. */
  name: S.optional(S.String),
  createdAt: S.Number,
  modifiedAt: S.Number,
  messageCount: S.Number,
  /** The first user message's text content; "(no messages)" when none. */
  firstMessage: S.String,
  /** Absolute path to the session file — the import key (opaque, unique). */
  path: S.String,
});
export type PiSessionInfo = S.Schema.Type<typeof PiSessionInfo>;

export const ListPiSessionsCommand = S.TaggedStruct("list_pi_sessions", {});
export const ImportPiSessionCommand = S.TaggedStruct("import_pi_session", {
  /** A `PiSessionInfo.path`, as returned by `list_pi_sessions`. */
  path: S.String,
});

export const PiSessionCommand = S.Union([ListPiSessionsCommand, ImportPiSessionCommand]);
export type PiSessionCommand = S.Schema.Type<typeof PiSessionCommand>;

export const ListPiSessionsResponse = S.TaggedStruct("list_pi_sessions", {
  sessions: S.Array(PiSessionInfo),
});
export const ImportPiSessionResponse = S.TaggedStruct("import_pi_session", {
  thread: ThreadInfo,
});

export const PiSessionResponse = S.Union([ListPiSessionsResponse, ImportPiSessionResponse]);
export type PiSessionResponse = S.Schema.Type<typeof PiSessionResponse>;
