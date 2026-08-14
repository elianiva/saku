import { Schema } from "effect";

export class CliError extends Schema.TaggedError<CliError>()("CliError", {
  code: Schema.Literals([
    "usage", // malformed command line (missing arguments, unknown command)
    "resolution", // a thread id/name did not resolve
    "worker_timeout", // the daemon did not come up after spawning
    "env_timeout", // the env daemon did not come up after spawning
    "spawn_failed", // spawning the worker/env daemon process failed
    "env_config", // the env identity could not be read or written
  ]),
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}
