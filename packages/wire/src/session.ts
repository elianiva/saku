/**
 * The wire's session feature: pi's own session vocabulary, carried verbatim,
 * plus the thread-scoped commands that drive it.
 *
 * Standing rule (ADR 0001): extend pi, never shim it. `AgentEvent`, `Entry`,
 * `SessionStats`, and friends cross the wire as-is (schemas here treat them
 * as opaque JSON payloads — they are pi's types, not ours to re-schema).
 * Everything saku adds is schema-validated with Effect's `Schema`.
 */

import { Schema as S } from "effect";
import type { AgentEvent, CompactResult, Entry, SessionStats, ThinkingLevel } from "@earendil-works/pi-agent-core";

import { ThreadInfo } from "./thread.ts";

// ---------------------------------------------------------------------------
// Shared session structs
// ---------------------------------------------------------------------------

export const ThinkingLevelSchema = S.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type ThinkingLevelSchema = S.Schema.Type<typeof ThinkingLevelSchema>;

export const WireModelInfo = S.Struct({
  provider: S.String,
  id: S.String,
  contextWindow: S.Number,
  reasoning: S.Boolean,
});
export type WireModelInfo = S.Schema.Type<typeof WireModelInfo>;

/** Session state snapshot (`get_state`), one source of truth per thread. */
export const ThreadSessionState = S.Struct({
  sessionId: S.Union([S.Null, S.String]),
  name: S.optional(S.String),
  state: S.Literals(["idle", "working", "crashed", "interrupted"]),
  tailSeq: S.Number,
  model: S.Union([S.Null, WireModelInfo]),
  thinkingLevel: ThinkingLevelSchema,
});
export type ThreadSessionState = S.Schema.Type<typeof ThreadSessionState>;

/** Tree shape returned by `get_tree`: lanes + every entry. */
export const WireTree = S.Struct({
  leafId: S.Union([S.Null, S.String]),
  lanes: S.Array(
    S.Struct({
      lane: S.String,
      leafId: S.Union([S.Null, S.String]),
    }),
  ),
  entries: S.Array(S.Unknown),
});
export type WireTree = S.Schema.Type<typeof WireTree>;

// ---------------------------------------------------------------------------
// Session commands (console → worker)
// ---------------------------------------------------------------------------

export const SessionCommand = S.Union([
  S.TaggedStruct("prompt", {
    text: S.String,
    images: S.optional(S.Array(S.Unknown)),
  }),
  S.TaggedStruct("steer", { text: S.String }),
  S.TaggedStruct("follow_up", { text: S.String }),
  S.TaggedStruct("abort", {}),
  S.TaggedStruct("set_steering_mode", { mode: S.Literals(["all", "one-at-a-time"]) }),
  S.TaggedStruct("set_follow_up_mode", { mode: S.Literals(["all", "one-at-a-time"]) }),
  S.TaggedStruct("get_messages", {}),
  S.TaggedStruct("get_last_assistant_text", {}),
  S.TaggedStruct("compact", { customInstructions: S.optional(S.String) }),
  S.TaggedStruct("set_auto_compaction", { enabled: S.Boolean }),
  S.TaggedStruct("get_available_models", {}),
  S.TaggedStruct("set_model", { provider: S.String, modelId: S.String }),
  S.TaggedStruct("cycle_model", {}),
  S.TaggedStruct("get_available_thinking_levels", {}),
  S.TaggedStruct("set_thinking_level", { level: ThinkingLevelSchema }),
  S.TaggedStruct("cycle_thinking_level", {}),
  S.TaggedStruct("get_entries", { sinceSeq: S.optional(S.Number) }),
  S.TaggedStruct("get_tree", {}),
  /** Move the session's leaf to a past entry; the next prompt forks there (idle only). */
  S.TaggedStruct("branch", { entryId: S.String }),
  S.TaggedStruct("get_session_stats", {}),
  S.TaggedStruct("set_session_name", { name: S.String }),
  S.TaggedStruct("get_state", {}),
]);
export type SessionCommand = S.Schema.Type<typeof SessionCommand>;

// ---------------------------------------------------------------------------
// Command responses (worker → console)
// ---------------------------------------------------------------------------

export const ResponsePayload = S.Union([
  S.TaggedStruct("prompt", {}),
  S.TaggedStruct("steer", {}),
  S.TaggedStruct("follow_up", {}),
  S.TaggedStruct("abort", {}),
  S.TaggedStruct("set_steering_mode", {}),
  S.TaggedStruct("set_follow_up_mode", {}),
  S.TaggedStruct("get_messages", { messages: S.Array(S.Unknown) }),
  S.TaggedStruct("get_last_assistant_text", { text: S.Union([S.Null, S.String]) }),
  S.TaggedStruct("compact", { result: S.Unknown }),
  S.TaggedStruct("set_auto_compaction", {}),
  S.TaggedStruct("get_available_models", { models: S.Array(WireModelInfo) }),
  S.TaggedStruct("set_model", { model: S.Union([S.Null, WireModelInfo]) }),
  S.TaggedStruct("cycle_model", { model: S.Union([S.Null, WireModelInfo]) }),
  S.TaggedStruct("get_available_thinking_levels", { levels: S.Array(ThinkingLevelSchema) }),
  S.TaggedStruct("set_thinking_level", { level: ThinkingLevelSchema }),
  S.TaggedStruct("cycle_thinking_level", { level: ThinkingLevelSchema }),
  S.TaggedStruct("get_entries", {
    entries: S.Array(S.Unknown),
    tailSeq: S.Number,
    leafId: S.Union([S.Null, S.String]),
  }),
  S.TaggedStruct("get_tree", { tree: WireTree }),
  S.TaggedStruct("branch", { leafId: S.Union([S.Null, S.String]) }),
  S.TaggedStruct("get_session_stats", { stats: S.Unknown }),
  S.TaggedStruct("set_session_name", {}),
  S.TaggedStruct("get_state", { state: ThreadSessionState }),
  S.TaggedStruct("list_threads", { threads: S.Array(ThreadInfo) }),
  S.TaggedStruct("create_thread", { thread: ThreadInfo }),
  S.TaggedStruct("get_thread", { thread: ThreadInfo }),
  S.TaggedStruct("delete_thread", {}),
  S.TaggedStruct("rename_thread", { thread: ThreadInfo }),
]);
export type ResponsePayload = S.Schema.Type<typeof ResponsePayload>;

// ---------------------------------------------------------------------------
// Session events (worker → console)
// ---------------------------------------------------------------------------

/**
 * Streaming session events: pi's `AgentEvent` verbatim, minus `agent_end`
 * (replaced by our `settled`) and with the cumulative `partial` snapshots
 * stripped from `message_update` — the projection pi's own shell ships to
 * its UIs. The durable layer rides separately via `get_entries` and
 * `entry_appended`.
 */
export type SessionWireEvent = SessionEventFromAgent | SessionEventFromSaku;

/** The subset of pi's event vocabulary that reaches consoles. */
type SessionEventFromAgent = {
  [K in AgentEvent as K["type"]]: K extends { readonly type: "agent_end" } ? never : StripPartial<K>;
}[AgentEvent["type"]];

type StripPartial<T> = T extends { readonly assistantMessageEvent: infer E }
  ? Omit<T, "assistantMessageEvent"> & {
      readonly assistantMessageEvent: E extends { readonly partial: unknown } ? Omit<E, "partial"> : E;
    }
  : T;

/** Saku's own session events — same `type`-discriminated vocabulary as pi's. */
export type SessionEventFromSaku =
  | { readonly type: "settled" }
  | { readonly type: "entry_appended"; readonly entry: Entry }
  | { readonly type: "compaction_start"; readonly reason: "manual" | "threshold" | "overflow" }
  | {
      readonly type: "compaction_end";
      readonly reason: "manual" | "threshold" | "overflow";
      readonly result: CompactResult | undefined;
      readonly aborted: boolean;
      readonly errorMessage?: string;
    };

export const Settled = S.TaggedStruct("settled", {});
export const EntryAppended = S.TaggedStruct("entry_appended", { entry: S.Unknown });
export const CompactionStart = S.TaggedStruct("compaction_start", {
  reason: S.Literals(["manual", "threshold", "overflow"]),
});
export const CompactionEnd = S.TaggedStruct("compaction_end", {
  reason: S.Literals(["manual", "threshold", "overflow"]),
  result: S.Unknown,
  aborted: S.Boolean,
  errorMessage: S.optional(S.String),
});

/** Schema for saku's own session events (pi's `AgentEvent` payloads pass through). */
export const SessionEventFromSakuSchema = S.Union([Settled, EntryAppended, CompactionStart, CompactionEnd]);

// Re-exported pi types so consoles never import pi directly for the session vocabulary.
export type { AgentEvent, CompactResult, Entry, SessionStats, ThinkingLevel };
