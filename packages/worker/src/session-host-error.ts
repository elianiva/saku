/**
 * The session host's failure type (session-host-error.ts), in its own
 * module so the machine, the agent-event projection, and the host value
 * share one error vocabulary without importing each other.
 *
 * `kind` discriminates the failure classes (model/auth/compaction/busy…)
 * so callers can `catchTag` instead of matching on message text. Every
 * construction site passes one.
 */

import { Schema } from "effect";

/** The session-host error kinds (`SessionHostError.kind`) — single source of truth. */
export const SessionHostErrorKinds = Schema.Literals([
  "unknown_model",
  "no_auth",
  "no_model",
  "compact_prepare",
  "pi_seam",
  "command_failed",
  "branch_busy",
  "unknown_entry",
  "unknown_thread",
  "no_env",
] as const);

export type SessionHostErrorKind = typeof SessionHostErrorKinds.Type;

/** A session-host failure: a pi-boundary, storage, or rejected command. */
export class SessionHostError extends Schema.TaggedError<SessionHostError>()("SessionHostError", {
  cause: Schema.optional(Schema.Unknown),
  kind: SessionHostErrorKinds,
  message: Schema.String,
}) {}

/** The human-readable failure text of any thrown value. */
export const messageOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

/** Map any pi-boundary failure onto the host's error type. */
export const toSessionHostError = (cause: unknown) =>
  cause instanceof SessionHostError
    ? cause
    : new SessionHostError({
        cause,
        kind: "pi_seam",
        message: messageOf(cause),
      });
