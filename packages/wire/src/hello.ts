/**
 * The wire's hello feature: the connection handshake.
 *
 * First line from a console is `hello`; the worker replies `hello_ok` (with
 * its pid and the wire version) or `error` and drops the socket. The token
 * comes from `~/.saku/auth` (0600, random, created on first daemon start).
 */

import { Schema as S } from "effect";

export const Hello = S.TaggedStruct("hello", {
  token: S.String,
  role: S.Literals(["cli"]),
});
export type Hello = S.Schema.Type<typeof Hello>;

export const HelloOk = S.TaggedStruct("hello_ok", {
  pid: S.Number,
  version: S.String,
});
export type HelloOk = S.Schema.Type<typeof HelloOk>;

// Handshake failure is the envelope's `error` frame — see ErrorEvent.
