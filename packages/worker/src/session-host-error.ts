/**
 * The session host's failure type (session-host-error.ts), in its own
 * module so the machine, the agent-event projection, and the host value
 * share one error vocabulary without importing each other.
 *
 * `kind` discriminates the failure classes (model/auth/compaction/busy…)
 * so callers can `catchTag` instead of matching on message text. The kind
 * is `optional` in the schema while the daemon (plan 02's file) still
 * constructs the error without one — every construction site in this
 * package passes a kind explicitly, and a follow-up can make the field
 * required once the daemon migrates.
 */

import { Schema } from "effect";

/** A session-host failure: a pi-boundary, storage, or rejected command. */
export class SessionHostError extends Schema.TaggedError<SessionHostError>()("SessionHostError", {
  kind: Schema.optional(
    Schema.Literals([
      "unknown_model",
      "no_auth",
      "no_model",
      "compact_prepare",
      "pi_seam",
      "command_failed",
      "branch_busy",
      "unknown_entry",
      "unknown_thread",
    ]),
  ),
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

/** Map any pi-boundary failure onto the host's error type. */
export const toSessionHostError = (error: unknown): SessionHostError =>
  error instanceof SessionHostError
    ? error
    : new SessionHostError({
        kind: "pi_seam",
        message: messageOf(error),
        cause: error,
      });

/** The human-readable failure text of any thrown value. */
export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
