/**
 * The registry's failure type (registry-error.ts), its own module so the
 * isolate entry (session host) can reference it without pulling the
 * node-bound file registry implementation.
 */

import { Schema } from "effect";

/** A registry-level failure (create/update/delete/file I/O). */
export class RegistryError extends Schema.TaggedError<RegistryError>()("RegistryError", {
  message: Schema.String,
  /** The local operation the failure belongs to (staged: optional until every construction site migrates). */
  op: Schema.optional(Schema.Literals(["list", "persist"])),
  cause: Schema.optional(Schema.Unknown),
}) {}
