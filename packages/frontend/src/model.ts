/**
 * The console's Model (model.ts): connection, thread rail, and the active
 * thread's view state (trail + live run + composer).
 *
 * The rail is the registry's projection (CONTEXT.md: Registry); the trail
 * and the live run are the active thread's wire-derived view, owned by the
 * live state machine (live.ts) — this file only composes them into the
 * model.
 */

import { Schema as S } from "effect";
import { ThreadInfo } from "@saku/wire";

import { initialLive, LiveRegion, Trail } from "./live.ts";

/** The wire connection lifecycle. */
export const Conn = S.Union([
  S.TaggedStruct("connecting", {}),
  S.TaggedStruct("online", { pid: S.Number, version: S.String }),
  S.TaggedStruct("offline", { error: S.optional(S.String) }),
]);
export type Conn = S.Schema.Type<typeof Conn>;

/** The thread rail (registry list). */
export const Rail = S.Union([
  S.TaggedStruct("loading", {}),
  S.TaggedStruct("failed", { error: S.String }),
  S.TaggedStruct("ready", { threads: S.Array(ThreadInfo) }),
]);
export type Rail = S.Schema.Type<typeof Rail>;

export const Model = S.Struct({
  conn: Conn,
  rail: Rail,
  /** The quick-start composer's text (rail). */
  railInput: S.String,
  /** The selected thread; null before any selection. */
  active: S.Union([S.Null, S.String]),
  trail: Trail,
  live: LiveRegion,
  /** The thread composer's text. */
  composer: S.String,
  /** A dismissible top-level notice (wire errors, command failures). */
  banner: S.optional(S.String),
});
export type Model = S.Schema.Type<typeof Model>;

export const initialModel: Model = {
  conn: { _tag: "connecting" },
  rail: { _tag: "loading" },
  railInput: "",
  active: null,
  ...initialLive(),
  composer: "",
};
