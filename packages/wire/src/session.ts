/**
 * The wire's session feature: pi's own session vocabulary, carried verbatim,
 * plus the thread-scoped commands that drive it.
 *
 * Standing rule (ADR 0005): extend pi, never shim it. `AgentEvent`, `Entry`,
 * `SessionStats`, and friends cross the wire as-is (schemas here treat them
 * as opaque JSON payloads — they are pi's types, not ours to re-schema).
 * Everything saku adds is schema-validated with Effect's `Schema`.
 *
 * The TUI-shaped sugar is gone (`cycle_model`, `cycle_thinking_level`,
 * `get_messages`, `get_last_assistant_text`, `get_tree`); the reads that
 * remain never start a session, so browsing a thread is free and a stopped
 * Box stays stopped until a prompt (ADR 0004).
 */

import { Schema as S } from "effect";
import type {
  AgentEvent,
  CompactResult,
  Entry,
  SessionStats,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";

import { SkillResponse } from "./skills.ts";
import { PiSessionResponse } from "./pi-sessions.ts";
import { ThreadInfo } from "./thread.ts";

/** The thinking-level ladder (pi's own `ThinkingLevel` vocabulary). */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const ThinkingLevelSchema = S.Literals(THINKING_LEVELS);
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
  state: S.Literals(["idle", "working", "interrupted"]),
  tailSeq: S.Number,
  model: S.Union([S.Null, WireModelInfo]),
  thinkingLevel: ThinkingLevelSchema,
});
export type ThreadSessionState = S.Schema.Type<typeof ThreadSessionState>;

export const PromptCommand = S.TaggedStruct("prompt", {
  text: S.String,
  images: S.optional(S.Array(S.Unknown)),
});
export const SteerCommand = S.TaggedStruct("steer", { text: S.String });
export const FollowUpCommand = S.TaggedStruct("follow_up", { text: S.String });
export const AbortCommand = S.TaggedStruct("abort", {});
export const SetSteeringModeCommand = S.TaggedStruct("set_steering_mode", {
  mode: S.Literals(["all", "one-at-a-time"]),
});
export const SetFollowUpModeCommand = S.TaggedStruct("set_follow_up_mode", {
  mode: S.Literals(["all", "one-at-a-time"]),
});
export const CompactCommand = S.TaggedStruct("compact", {
  customInstructions: S.optional(S.String),
});
export const SetAutoCompactionCommand = S.TaggedStruct("set_auto_compaction", {
  enabled: S.Boolean,
});
export const GetAvailableModelsCommand = S.TaggedStruct("get_available_models", {});
export const SetModelCommand = S.TaggedStruct("set_model", {
  provider: S.String,
  modelId: S.String,
});
export const GetAvailableThinkingLevelsCommand = S.TaggedStruct(
  "get_available_thinking_levels",
  {},
);
export const SetThinkingLevelCommand = S.TaggedStruct("set_thinking_level", {
  level: ThinkingLevelSchema,
});
export const GetEntriesCommand = S.TaggedStruct("get_entries", { sinceSeq: S.optional(S.Number) });
export const BranchCommand = S.TaggedStruct("branch", { entryId: S.String });
export const GetSessionStatsCommand = S.TaggedStruct("get_session_stats", {});
export const SetSessionNameCommand = S.TaggedStruct("set_session_name", { name: S.String });
export const GetStateCommand = S.TaggedStruct("get_state", {});

export const SessionCommand = S.Union([
  PromptCommand,
  SteerCommand,
  FollowUpCommand,
  AbortCommand,
  SetSteeringModeCommand,
  SetFollowUpModeCommand,
  CompactCommand,
  SetAutoCompactionCommand,
  GetAvailableModelsCommand,
  SetModelCommand,
  GetAvailableThinkingLevelsCommand,
  SetThinkingLevelCommand,
  GetEntriesCommand,
  BranchCommand,
  GetSessionStatsCommand,
  SetSessionNameCommand,
  GetStateCommand,
]);
export type SessionCommand = S.Schema.Type<typeof SessionCommand>;

/**
 * The session commands that never start a session or wake an env (ADR 0004):
 * browsing a thread is free, and a stopped Box stays stopped until a prompt.
 * The shared session-command dispatch (worker/session-commands.ts) serves
 * these from the registry/catalog alone when no session host exists.
 */
export const READ_ONLY_COMMANDS: ReadonlySet<SessionCommand["_tag"]> = new Set([
  "get_entries",
  "get_state",
  "get_available_models",
  "get_available_thinking_levels",
]);

export const PromptResponse = S.TaggedStruct("prompt", {});
export const SteerResponse = S.TaggedStruct("steer", {});
export const FollowUpResponse = S.TaggedStruct("follow_up", {});
export const AbortResponse = S.TaggedStruct("abort", {});
export const SetSteeringModeResponse = S.TaggedStruct("set_steering_mode", {});
export const SetFollowUpModeResponse = S.TaggedStruct("set_follow_up_mode", {});
export const CompactResponse = S.TaggedStruct("compact", { result: S.Unknown });
export const SetAutoCompactionResponse = S.TaggedStruct("set_auto_compaction", {});
export const GetAvailableModelsResponse = S.TaggedStruct("get_available_models", {
  models: S.Array(WireModelInfo),
});
export const SetModelResponse = S.TaggedStruct("set_model", {
  model: S.Union([S.Null, WireModelInfo]),
});
export const GetAvailableThinkingLevelsResponse = S.TaggedStruct("get_available_thinking_levels", {
  levels: S.Array(ThinkingLevelSchema),
});
export const SetThinkingLevelResponse = S.TaggedStruct("set_thinking_level", {
  level: ThinkingLevelSchema,
});
export const GetEntriesResponse = S.TaggedStruct("get_entries", {
  entries: S.Array(S.Unknown),
  tailSeq: S.Number,
  leafId: S.Union([S.Null, S.String]),
});
export const BranchResponse = S.TaggedStruct("branch", { leafId: S.Union([S.Null, S.String]) });
export const GetSessionStatsResponse = S.TaggedStruct("get_session_stats", { stats: S.Unknown });
export const SetSessionNameResponse = S.TaggedStruct("set_session_name", {});
export const GetStateResponse = S.TaggedStruct("get_state", { state: ThreadSessionState });
export const ListThreadsResponse = S.TaggedStruct("list_threads", { threads: S.Array(ThreadInfo) });
export const CreateThreadResponse = S.TaggedStruct("create_thread", { thread: ThreadInfo });
export const GetThreadResponse = S.TaggedStruct("get_thread", { thread: ThreadInfo });
export const DeleteThreadResponse = S.TaggedStruct("delete_thread", {});
export const RenameThreadResponse = S.TaggedStruct("rename_thread", { thread: ThreadInfo });

export const ResponsePayload = S.Union([
  PromptResponse,
  SteerResponse,
  FollowUpResponse,
  AbortResponse,
  SetSteeringModeResponse,
  SetFollowUpModeResponse,
  CompactResponse,
  SetAutoCompactionResponse,
  GetAvailableModelsResponse,
  SetModelResponse,
  GetAvailableThinkingLevelsResponse,
  SetThinkingLevelResponse,
  GetEntriesResponse,
  BranchResponse,
  GetSessionStatsResponse,
  SetSessionNameResponse,
  GetStateResponse,
  ListThreadsResponse,
  CreateThreadResponse,
  GetThreadResponse,
  DeleteThreadResponse,
  RenameThreadResponse,
  SkillResponse,
  PiSessionResponse,
]);
export type ResponsePayload = S.Schema.Type<typeof ResponsePayload>;

/** The response payload variant for one command kind — derived from the schema. */
export type SessionResponse<K extends ResponsePayload["_tag"]> = Extract<
  ResponsePayload,
  { readonly _tag: K }
>;

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
  [K in AgentEvent as K["type"]]: K extends { readonly type: "agent_end" }
    ? never
    : StripPartial<K>;
}[AgentEvent["type"]];

type StripPartial<T> = T extends { readonly assistantMessageEvent: infer E }
  ? Omit<T, "assistantMessageEvent"> & {
      readonly assistantMessageEvent: E extends { readonly partial: unknown }
        ? Omit<E, "partial">
        : E;
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

// Re-exported pi types so consoles never import pi directly for the session vocabulary.
export type { AgentEvent, CompactResult, Entry, SessionStats, ThinkingLevel };
