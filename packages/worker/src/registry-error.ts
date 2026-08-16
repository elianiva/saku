/**
 * The registry's failure type (registry-error.ts), its own module so the
 * isolate entry (session host) can reference it without pulling the
 * node-bound file registry implementation.
 */

import { Schema } from "effect";

/** Alias of `Schema.TaggedError` so oxlint's Error-name call heuristic
 * doesn't demand `new` on the factory call (which would break typecheck). */
const taggedError = Schema.TaggedError;

/** A registry-level failure (create/update/delete/file I/O). */
export class RegistryError extends taggedError<RegistryError>()("RegistryError", {
  cause: Schema.optional(Schema.Unknown),
  message: Schema.String,
  /** The local operation the failure belongs to (staged: optional until every construction site migrates). */
  op: Schema.optional(Schema.Literals(["list", "persist"])),
}) {}
