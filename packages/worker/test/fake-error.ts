/**
 * The fake catalog's failure type (fake-error.ts), its own module so the
 * fakes file stays at one class (max-classes-per-file).
 */

import { Schema } from "effect";

/** Alias of `Schema.TaggedError` so oxlint's Error-name call heuristic
 * doesn't demand `new` on the factory call (which would break typecheck). */
const taggedError = Schema.TaggedError;

/** A scripted failure of the fake catalog (an unimplemented or failing surface). */
export class FakeError extends taggedError<FakeError>()("FakeError", {
  message: Schema.String,
}) {}
