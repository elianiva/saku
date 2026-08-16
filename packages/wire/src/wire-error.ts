/**
 * The client-side wire failure (wire-error.ts): any error a console's
 * `WireClient` surfaces — connection-level failures (disconnected,
 * handshake, refused) and command failures (timeout, decode, the server's
 * own `command_failed` reply).
 */

import { Schema } from "effect";

// Aliased so the TaggedError class declaration below stays a plain call
// (oxlint's throw-new-error would demand `new`, which breaks the schema
// typecheck — `TaggedError` is a function returning a class, not a class).
const tagged = Schema.TaggedError;

export class WireError extends tagged<WireError>()("WireError", {
  cause: Schema.optional(Schema.Unknown),
  code: Schema.Literals([
    "disconnected",
    "handshake",
    "timeout",
    "decode",
    "refused",
    "command_failed",
  ]),
  message: Schema.String,
}) {}
