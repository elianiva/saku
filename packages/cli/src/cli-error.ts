/**
 * The CLI's failure type (cli-error.ts): every failure the saku CLI can
 * produce, in its own module so the command dispatcher (entry.ts) and the
 * daemon/env stewards (daemon.ts, env.ts) share one error vocabulary.
 *
 * `code` discriminates the failure classes so the process edge can
 * `catchTag` instead of matching message text; `message` is what the
 * `saku:` line prints. Even the process edge is a tagged error — the CLI
 * is the last line of the stack, not an excuse for a plain `Error`.
 */

import { Schema } from "effect";

/** The CLI failure classes. */
export class CliError extends Schema.TaggedError<CliError>()("CliError", {
  code: Schema.Literals([
    "usage", // malformed command line (missing arguments, unknown command)
    "missing_url", // the worker never published its url
    "missing_token", // the worker never created the auth token
    "resolution", // a thread id/name did not resolve
    "worker_timeout", // the daemon did not come up after spawning
    "env_timeout", // the env daemon did not come up after spawning
    "spawn_failed", // spawning the worker/env daemon process failed
  ]),
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}
