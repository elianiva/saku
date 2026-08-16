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
// Aliased so the TaggedError class declaration below stays a plain call
// (oxlint's throw-new-error would demand `new`, which breaks the schema
// typecheck — `TaggedError` is a function returning a class, not a class).
const tagged = Schema.TaggedError;

/** The hub error categories (`HubError.kind`). */
export type HubErrorKind =
  // thread lookups/record failures surfaced as hub errors
  | "registry"
  // workerRef forwarding/create failures
  | "worker"
  // env ensure/release failures
  | "provisioner"
  // unknown/ambiguous thread input
  | "resolution"
  // unknown skill
  | "skills"
  // local-daemon-only commands (the hub never sees ~/.pi)
  | "pi_sessions"
  // local-daemon-only commands (the window's scope lives on the machine)
  | "projects"
  // command validation (empty name, missing threadId)
  | "command"
  // the hub's wire server failed to come up
  | "startup";

export class HubError extends tagged<HubError>()("HubError", {
  cause: Schema.optional(Schema.Unknown),
  kind: Schema.Literals([
    "registry",
    "worker",
    "provisioner",
    "resolution",
    "skills",
    "pi_sessions",
    "projects",
    "command",
    "startup",
  ]),
  message: Schema.String,
}) {}
