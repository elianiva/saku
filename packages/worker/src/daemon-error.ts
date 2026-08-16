/**
 * Daemon errors (daemon-error.ts): the command-level and startup failures
 * owned by the daemon (resolve/validation/listen), kept in their own module
 * so daemon.ts holds a single class (the wire's command dispatch surface).
 */

import { Schema } from "effect";

/** Alias of `Schema.TaggedError` so oxlint's Error-name call heuristic
 * doesn't demand `new` on the factory call (which would break typecheck). */
const taggedError = Schema.TaggedError;

/** A command-level or startup failure owned by the daemon (resolve/validation/listen). */
export class DaemonError extends taggedError<DaemonError>()("DaemonError", {
  cause: Schema.optional(Schema.Unknown),
  code: Schema.Literals([
    "unknown_thread",
    "empty_name",
    "skills_not_served",
    "pi_sessions_not_served",
    "pi_sessions",
    "already_imported",
    "unknown_command",
    "startup",
    "resolution",
    "projects",
  ]),
  message: Schema.String,
}) {}
