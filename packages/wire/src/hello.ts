/**
 * The wire's hello feature: the connection handshake.
 *
 * First frame from a console is `hello`; the server replies `hello_ok` (with
 * its pid and the wire version) or `error` and drops the connection. The
 * token is the deployment secret; `version` is the console's wire version
 * (a mismatch is rejected before anything else is exchanged).
 */

import { Schema as S } from "effect";

/** Console roles: the foldkit frontend, and saku's own tooling (the CLI). */
export const ConsoleRole = S.Literals(["frontend", "cli"]);
export type ConsoleRole = S.Schema.Type<typeof ConsoleRole>;

export const Hello = S.TaggedStruct("hello", {
  token: S.String,
  role: ConsoleRole,
  version: S.String,
});
export type Hello = S.Schema.Type<typeof Hello>;

export const HelloOk = S.TaggedStruct("hello_ok", {
  pid: S.Number,
  version: S.String,
});
export type HelloOk = S.Schema.Type<typeof HelloOk>;

// Handshake failure is the envelope's `error` frame — see ErrorEvent.
