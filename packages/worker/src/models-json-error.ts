/**
 * The models.json configuration failure (models-json-error.ts), in its own
 * module so the catalog's construction sites share one error type without
 * crowding model-catalog.ts (one class per file).
 */

import { Schema } from "effect";

/** A models.json configuration problem (missing api/baseUrl, unknown api implementation, empty provider). */
export class ModelsJsonError extends Schema.TaggedError<ModelsJsonError>()("ModelsJsonError", {
  message: Schema.String,
}) {}
