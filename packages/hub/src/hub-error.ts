/**
 * The hub's error type: every command-level failure the hub can produce
 * (registry persistence, worker forwarding, env provisioning, thread
 * resolution, skills store). One type — the wire turns it into a
 * `response {ok: false, error}` frame; the server never sees its shape.
 *
 * `kind` discriminates the failure category (house model: `WireError`'s
 * `code` literals). It is staged-optional: construction sites owned by
 * other plans (`hub/src/registry.ts`, `skills.ts`, `wire-core.ts`) still
 * construct `HubError` without it while they migrate — so `kind` stays
 * optional until every site passes one, then a follow-up makes it
 * required. New code constructs via `makeHubError(kind, message, cause?)`.
 */

import { Schema } from "effect";

/** The hub error categories (`HubError.kind`; staged-optional). */
export type HubErrorKind =
  | "registry" // thread lookups/record failures surfaced as hub errors
  | "worker" // workerRef forwarding/create failures
  | "provisioner" // env ensure/release failures
  | "resolution" // unknown/ambiguous thread input
  | "skills" // unknown skill
  | "command"; // command validation (empty name, missing threadId)

export class HubError extends Schema.TaggedError<HubError>()("HubError", {
  kind: Schema.optional(
    Schema.Literals(["registry", "worker", "provisioner", "resolution", "skills", "command"]),
  ),
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

/** Construct a hub error with its category (required at new sites). */
export const makeHubError = (kind: HubErrorKind, message: string, cause?: unknown): HubError =>
  new HubError({ kind, message, cause });

/** The user-facing message of any failure the hub's command handlers produce. */
export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
