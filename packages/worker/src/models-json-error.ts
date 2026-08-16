/**
 * The models.json configuration failure (models-json-error.ts), in its own
 * module so the catalog's construction sites share one error type without
 * crowding model-catalog.ts (one class per file).
 */

import { Schema } from "effect";

/** Alias of `Schema.TaggedError` so oxlint's Error-name call heuristic
 * doesn't demand `new` on the factory call (which would break typecheck). */
const taggedError = Schema.TaggedError;

/** A models.json configuration problem (missing api/baseUrl, unknown api implementation, empty provider). */
export class ModelsJsonError extends taggedError<ModelsJsonError>()("ModelsJsonError", {
  message: Schema.String,
}) {}
