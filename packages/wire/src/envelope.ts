/**
 * The wire's envelope feature: the top-level frame types that give every
 * pi-shaped payload its thread layer.
 *
 * One flat `command` frame: session commands carry a `threadId`, hub-level
 * commands (threads, skills) don't — routing is stateless, the server
 * dispatches on the frame alone.
 */

import { Schema as S } from "effect";

import { HelloOk } from "./hello.ts";
import { ThreadChanged, ThreadCommand } from "./thread.ts";
import { PiSessionCommand } from "./pi-sessions.ts";
import { ProjectCommand } from "./projects.ts";
import { ResponsePayload, SessionCommand } from "./session.ts";
import { SkillCommand } from "./skills.ts";

/** One JSON frame from console to server. */
export const WireCommand = S.TaggedStruct("command", {
  command: S.Union([SessionCommand, ThreadCommand, SkillCommand, PiSessionCommand, ProjectCommand]),
  id: S.String,
  /** Present on session commands; hub-level commands (threads, skills, pi sessions) omit it. */
  threadId: S.optional(S.String),
});
export type WireCommand = S.Schema.Type<typeof WireCommand>;

export const ResponseOk = S.TaggedStruct("response", {
  id: S.String,
  ok: S.Literal(true),
  payload: ResponsePayload,
});
export type ResponseOk = S.Schema.Type<typeof ResponseOk>;

export const ResponseError = S.TaggedStruct("response", {
  error: S.String,
  id: S.String,
  ok: S.Literal(false),
});
export type ResponseError = S.Schema.Type<typeof ResponseError>;

/** A streamed session event, fanned out to every connected console. */
export const EventFrame = S.TaggedStruct("event", {
  event: S.Unknown,
  threadId: S.String,
});
export type EventFrame = S.Schema.Type<typeof EventFrame>;

/** Connection-level error (handshake failure, malformed input, internal fault). */
export const ErrorEvent = S.TaggedStruct("error", { message: S.String });
export type ErrorEvent = S.Schema.Type<typeof ErrorEvent>;

/**
 * The heartbeat (C2's keepalive): the client pings while connected and the
 * server answers — a half-open socket (laptop sleep, NAT timeout) is
 * detected by the missing pong, not by the next failed send. Carries no
 * payload; the pong echoes nothing.
 */
export const Ping = S.TaggedStruct("ping", {});
export type Ping = S.Schema.Type<typeof Ping>;

/** The server's heartbeat answer. */
export const Pong = S.TaggedStruct("pong", {});
export type Pong = S.Schema.Type<typeof Pong>;

/** One JSON frame from server to console. */
export const WireEvent = S.Union([
  HelloOk,
  ResponseOk,
  ResponseError,
  EventFrame,
  ThreadChanged,
  ErrorEvent,
  Pong,
]);
export type WireEvent = S.Schema.Type<typeof WireEvent>;
