/**
 * The server-core's protocol violation (wire-server-error.ts): a malformed
 * command frame (a session command without a threadId, today).
 */

import { Schema } from "effect";

// Aliased so the TaggedError class declaration below stays a plain call
// (oxlint's throw-new-error would demand `new`, which breaks the schema
// typecheck — `TaggedError` is a function returning a class, not a class).
const tagged = Schema.TaggedError;

/** The wire-server error codes (`WireServerError.code`) — single source of truth. */
export const WireServerErrorCodes = Schema.Literals(["missing_thread_id"] as const);

export type WireServerErrorCode = typeof WireServerErrorCodes.Type;

/** A protocol violation detected by the server core. */
export class WireServerError extends tagged<WireServerError>()("WireServerError", {
  code: WireServerErrorCodes,
  message: Schema.String,
}) {}
