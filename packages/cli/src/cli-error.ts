import { Schema } from "effect";

/** The CLI error codes (`CliError.code`) — single source of truth. */
export const CliErrorCodes = Schema.Literals([
  // malformed command line (missing arguments, unknown command)
  "usage",
  // a thread id/name did not resolve
  "resolution",
  // the daemon did not come up after spawning
  "worker_timeout",
  // the env daemon did not come up after spawning
  "env_timeout",
  // spawning the worker/env daemon process failed
  "spawn_failed",
  // the env identity could not be read or written
  "env_config",
] as const);

export type CliErrorCode = typeof CliErrorCodes.Type;

export class CliError extends Schema.TaggedError<CliError>()("CliError", {
  cause: Schema.optional(Schema.Unknown),
  code: CliErrorCodes,
  message: Schema.String,
}) {}
