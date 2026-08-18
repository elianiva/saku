/**
 * Daemon errors (daemon-error.ts): the command-level and startup failures
 * owned by the daemon (resolve/validation/listen), kept in their own module
 * so daemon.ts holds a single class (the wire's command dispatch surface).
 */

import { Schema } from "effect";

/** The daemon error codes (`DaemonError.code`) — single source of truth. */
export const DaemonErrorCodes = Schema.Literals([
  "unknown_thread",
  "empty_name",
  "skills_not_served",
  "pi_sessions",
  "already_imported",
  "startup",
  "resolution",
] as const);

export type DaemonErrorCode = typeof DaemonErrorCodes.Type;

/** A command-level or startup failure owned by the daemon (resolve/validation/listen). */
export class DaemonError extends Schema.TaggedError<DaemonError>()("DaemonError", {
  cause: Schema.optional(Schema.Unknown),
  code: DaemonErrorCodes,
  message: Schema.String,
}) {}
