/**
 * A connection-level failure of the env protocol (connect/hello), tagged
 * so callers can distinguish a rejected hello from a timeout or a socket
 * failure instead of matching message text.
 */
import { Schema } from "effect";

// Aliased so the TaggedError class declaration stays a plain call
// (oxlint's throw-new-error would demand `new`, which breaks the schema
// typecheck — `TaggedError` is a function returning a class, not a class).
const tagged = Schema.TaggedError;

/** A connection-level failure of the env protocol (connect/hello). */
export class EnvConnectionError extends tagged<EnvConnectionError>()("EnvConnectionError", {
  cause: Schema.optional(Schema.Unknown),
  kind: Schema.Literals([
    "already_connected",
    "socket_error",
    "closed_before_hello",
    "hello_timeout",
    "rejected",
  ]),
  message: Schema.String,
}) {}
