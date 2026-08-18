/**
 * The hub's error type: every failure the hub can produce — command-level
 * (registry persistence, worker forwarding, env provisioning, thread
 * resolution, skills store) and startup. One type — the wire turns it into
 * a `response {ok: false, error}` frame; the server never sees its shape.
 *
 * `kind` discriminates the failure category (house model: `WireError`'s
 * `code` literals). Every construction site passes one.
 */

import { Schema } from "effect";
// The canonical user-facing message helper lives in the wire's server core
// (wire/src/server-core.ts); the hub re-exports it rather than re-defining it.
export { messageOf } from "@saku/wire/server";

/** The hub error categories (`HubError.kind`) — single source of truth. */
export const HubErrorKinds = Schema.Literals([
  // thread lookups/record failures surfaced as hub errors
  "registry",
  // workerRef forwarding/create failures
  "worker",
  // env ensure/release failures
  "provisioner",
  // unknown/ambiguous thread input
  "resolution",
  // unknown skill
  "skills",
  // local-daemon-only commands (the hub never sees ~/.pi)
  "pi_sessions",
  // local-daemon-only commands (the window's scope lives on the machine)
  "projects",
  // command validation (empty name, missing threadId)
  "command",
  // the hub's wire server failed to come up
  "startup",
] as const);

export type HubErrorKind = typeof HubErrorKinds.Type;

export class HubError extends Schema.TaggedError<HubError>()("HubError", {
  cause: Schema.optional(Schema.Unknown),
  kind: HubErrorKinds,
  message: Schema.String,
}) {}
