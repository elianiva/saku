/**
 * The hub's error type: every failure the hub can produce — command-level
 * (registry persistence, worker forwarding, env provisioning, thread
 * resolution, skills store) and startup. One type — the wire turns it into
 * a `response {ok: false, error}` frame; the server never sees its shape.
 *
 * `kind` discriminates the failure category (house model: `WireError`'s
 * `code` literals). Every construction site passes one (prefer the
 * `makeHubError(kind, message, cause?)` helper).
 */

import { Schema } from "effect";

/** The hub error categories (`HubError.kind`). */
export type HubErrorKind =
  | "registry" // thread lookups/record failures surfaced as hub errors
  | "worker" // workerRef forwarding/create failures
  | "provisioner" // env ensure/release failures
  | "resolution" // unknown/ambiguous thread input
  | "skills" // unknown skill
  | "command" // command validation (empty name, missing threadId)
  | "startup"; // the hub's wire server failed to come up

export class HubError extends Schema.TaggedError<HubError>()("HubError", {
  kind: Schema.Literals([
    "registry",
    "worker",
    "provisioner",
    "resolution",
    "skills",
    "command",
    "startup",
  ]),
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

/** Construct a hub error with its category (required at new sites). */
export const makeHubError = (kind: HubErrorKind, message: string, cause?: unknown): HubError =>
  new HubError({ kind, message, cause });

/** The user-facing message of any failure the hub's command handlers produce. */
export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
