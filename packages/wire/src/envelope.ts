/**
 * The wire's envelope feature: the top-level frame types that give every
 * pi-shaped payload its thread layer.
 */

import { Schema as S } from "effect";

import { HelloOk } from "./hello.ts";
import { ThreadCommand, ThreadChanged } from "./thread.ts";
import { ResponsePayload, SessionCommand } from "./session.ts";

/** One JSON line from console to worker. */
export const WireCommand = S.Union([
  S.TaggedStruct("session", {
    id: S.optional(S.String),
    threadId: S.String,
    command: SessionCommand,
  }),
  S.TaggedStruct("thread", {
    id: S.optional(S.String),
    command: ThreadCommand,
  }),
]);
export type WireCommand = S.Schema.Type<typeof WireCommand>;

export const ResponseOk = S.TaggedStruct("response", {
  id: S.String,
  ok: S.Literal(true),
  payload: ResponsePayload,
});
export type ResponseOk = S.Schema.Type<typeof ResponseOk>;

export const ResponseError = S.TaggedStruct("response", {
  id: S.String,
  ok: S.Literal(false),
  error: S.String,
});
export type ResponseError = S.Schema.Type<typeof ResponseError>;

/** A streamed session event, fanned out to every connected console. */
export const SessionEventEnvelope = S.TaggedStruct("event", {
  threadId: S.String,
  event: S.Unknown,
});
export type SessionEventEnvelope = S.Schema.Type<typeof SessionEventEnvelope>;

/** Connection-level error (handshake failure, malformed input, internal fault). */
export const ErrorEvent = S.TaggedStruct("error", { message: S.String });
export type ErrorEvent = S.Schema.Type<typeof ErrorEvent>;

/** One JSON line from worker to console. */
export const WireEvent = S.Union([
  HelloOk,
  ResponseOk,
  ResponseError,
  SessionEventEnvelope,
  ThreadChanged,
  ErrorEvent,
]);
export type WireEvent = S.Schema.Type<typeof WireEvent>;

/** Typed view of a decoded wire event. */
export type WireEventKind = WireEvent["_tag"];
