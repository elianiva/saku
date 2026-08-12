/**
 * The hub's error type: every command-level failure the hub can produce
 * (registry persistence, worker forwarding, env provisioning, thread
 * resolution, skills store). One type — the wire turns it into a
 * `response {ok: false, error}` frame; the server never sees its shape.
 */

import { Schema } from "effect";

export class HubError extends Schema.TaggedError<HubError>()("HubError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

/** The user-facing message of any failure the hub's command handlers produce. */
export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
