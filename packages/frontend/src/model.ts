/**
 * The console's Model (model.ts): connection, thread rail, and the active
 * thread's view state (trail + live run + composer).
 *
 * The rail is the registry's projection (CONTEXT.md: Registry); the trail is
 * the entry log read via `get_entries` and extended by `entry_appended`
 * events; the live region renders the run in flight — the streaming message
 * and tool activity — which the trail absorbs as entries land.
 */

import { Schema as S } from "effect";
import { ThreadInfo } from "@saku/wire";

import { EntryProjection } from "./projection.ts";

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

/** The active thread's entry trail. Entries are pi's — rendered through the console's projection. */
export const Trail = S.Union([
  S.TaggedStruct("loading", {}),
  S.TaggedStruct("failed", { error: S.String }),
  S.TaggedStruct("ready", { entries: S.Array(EntryProjection), tailSeq: S.Number }),
]);
export type Trail = S.Schema.Type<typeof Trail>;

/** One tool call in the live run (tool_execution_* events). */
export const LiveTool = S.Struct({
  callId: S.String,
  name: S.String,
  state: S.Literals(["running", "done", "failed"]),
  /** Streamed partial output while running. */
  partial: S.optional(S.String),
  /** The final result (or error output). */
  result: S.optional(S.String),
});
export type LiveTool = S.Schema.Type<typeof LiveTool>;

/** The run in flight: streaming message, thinking, tool activity, notices. */
export const Live = S.Struct({
  message: S.optional(S.String),
  thinking: S.optional(S.String),
  tools: S.Array(LiveTool),
  notice: S.optional(S.String),
});
export type Live = S.Schema.Type<typeof Live>;

export const Model = S.Struct({
  conn: Conn,
  rail: Rail,
  /** The quick-start composer's text (rail). */
  railInput: S.String,
  /** The selected thread; null before any selection. */
  active: S.Union([S.Null, S.String]),
  trail: Trail,
  live: Live,
  /** The thread composer's text. */
  composer: S.String,
  /** A dismissible top-level notice (wire errors, command failures). */
  banner: S.optional(S.String),
});
export type Model = S.Schema.Type<typeof Model>;

export const emptyLive = (): Live => ({ tools: [] });

export const initialModel: Model = {
  conn: { _tag: "connecting" },
  rail: { _tag: "loading" },
  railInput: "",
  active: null,
  trail: { _tag: "loading" },
  live: emptyLive(),
  composer: "",
};
