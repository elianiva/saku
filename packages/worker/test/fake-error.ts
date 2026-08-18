/**
 * The fake catalog's failure type (fake-error.ts), its own module so the
 * fakes file stays at one class (max-classes-per-file).
 */

import { Schema } from "effect";

/** A scripted failure of the fake catalog (an unimplemented or failing surface). */
export class FakeError extends Schema.TaggedError<FakeError>()("FakeError", {
  message: Schema.String,
}) {}
