/**
 * The live-run fold (live.ts): the active thread's wire-derived view — the
 * entry trail (AsyncData) plus the run in flight — folded as PURE functions.
 *
 * This is the console's most correctness-sensitive logic: the streaming
 * message/tool folds, the complete-entry-clears-streaming-copy invariant,
 * trail dedupe, and the settled reset. It lives here — no foldkit runtime,
 * no DOM, no `Wire` service at module scope — so tests exercise it in
 * isolation. thread/update.ts delegates: wire events for the active thread
 * fold through `foldLive`, which returns the next state; the trail's chat
 * scroller (scroller.ts) follows the growing view on the DOM side — the
 * shadcn message-scroller pattern, observer-driven instead of scroll
 * commands. Everything else about the pane stays in thread/update.ts.
 *
 * The trail is foldkit's AsyncData (Idle → Success/Failure): the pane
 * renders what is loaded; the fold grows `Success` in place.
 */

import { Match as M, Schema as S } from "effect";
import { AsyncData } from "foldkit";

import { asString, messageText, messageThinking, stringifyLive } from "./format.ts";
import { EntryProjection } from "./projection.ts";
import type { SessionEventProjection } from "./projection.ts";

/** The trail's loaded payload: the entries plus the last sequence seen. */
export const TrailData = S.Struct({
  entries: S.Array(EntryProjection),
  tailSeq: S.Number,
});
export type TrailData = S.Schema.Type<typeof TrailData>;

/** The entry trail as AsyncData: idle (nothing fetched) → success/failure. */
export const Trail = AsyncData.Schema(TrailData, S.String);
export const trail = Trail;

/** The decoded trail state the fold grows. */
export type TrailState = S.Schema.Type<typeof Trail.schema>;

/** One tool call in the live run (tool_execution_* events). */
export const LiveTool = S.Struct({
  /** The tool's arguments (pi sends them on start and each update). */
  args: S.optional(S.Json),
  callId: S.String,
  name: S.String,
  /** Streamed partial output while running. */
  partial: S.optional(S.String),
  /** The final result (or error output). */
  result: S.optional(S.String),
  state: S.Literals(["running", "done", "failed"]),
});
export type LiveTool = S.Schema.Type<typeof LiveTool>;

/** The run in flight: streaming message, thinking, tool activity, notices. */
export const LiveRegion = S.Struct({
  message: S.optional(S.String),
  notice: S.optional(S.String),
  thinking: S.optional(S.String),
  tools: S.Array(LiveTool),
});
export type LiveRegion = S.Schema.Type<typeof LiveRegion>;

/** The active thread's wire-derived view: the trail plus the run in flight. */
export interface Live {
  readonly trail: TrailState;
  readonly live: LiveRegion;
}

/** The live region before anything streamed. */
export const emptyLiveRegion = () => ({ tools: [] });

/** `entry_appended` on the active thread: grow the trail, dedupe by id. */
const foldEntryAppended = (state: Live, entry: EntryProjection): Live => {
  if (!AsyncData.isSuccess(state.trail)) {
    return state;
  }
  const last = state.trail.data.entries.at(-1);
  const id = asString(entry.id);
  if (last !== undefined && asString(last.id) === id) {
    return state;
  }
  // A message entry lands complete — the live region's copy of it is stale.
  const live =
    entry.type === "message"
      ? { ...state.live, message: undefined, thinking: undefined }
      : state.live;
  return {
    ...state,
    live,
    trail: Trail.Success({
      data: {
        entries: [...state.trail.data.entries, entry],
        tailSeq: Math.max(state.trail.data.tailSeq, entry.seq ?? 0),
      },
    }),
  };
};

const foldLiveTool = (tools: readonly LiveTool[], callId: string, next: Partial<LiveTool>) =>
  tools.map((tool) => (tool.callId === callId ? { ...tool, ...next } : tool));

/** The streaming message body shared by `message_start`/`message_end`. */
const messageLive = (state: Live, text: string) => ({
  ...state,
  live: { ...state.live, message: text },
});

/**
 * Fold one session event into the active thread's view. Returns the next
 * state; the trail's chat scroller observes growth on the DOM side
 * (scroller.ts — the shadcn message-scroller pattern). The streamed live
 * region is absorbed by the trail as entries land; `settled` clears the
 * region for the next run.
 */
export const foldLive = (state: Live, event: SessionEventProjection): Live =>
  M.value(event).pipe(
    M.withReturnType<Live>(),
    M.tagsExhaustive({
      compaction_end: () => ({ ...state, live: { ...state.live, notice: undefined } }),
      compaction_start: ({ reason }) => ({
        ...state,
        live: { ...state.live, notice: `compacting (${reason})` },
      }),
      entry_appended: ({ entry }) => foldEntryAppended(state, entry),
      message_end: ({ message }) => messageLive(state, messageText(message)),
      message_start: ({ message }) => messageLive(state, messageText(message)),
      message_update: ({ message }) => {
        const text = messageText(message);
        const thinking = messageThinking(message);
        // Partial updates may omit a field; an absent stream keeps its value.
        return {
          ...state,
          live: {
            ...state.live,
            message: text === "" ? state.live.message : text,
            thinking: thinking === "" ? state.live.thinking : thinking,
          },
        };
      },
      settled: () => ({ ...state, live: emptyLiveRegion() }),
      tool_execution_end: ({ toolCallId, isError, result }) => ({
        ...state,
        live: {
          ...state.live,
          tools: foldLiveTool(state.live.tools, toolCallId, {
            result: stringifyLive(result),
            state: isError ? "failed" : "done",
          }),
        },
      }),
      tool_execution_start: ({ toolCallId, toolName, args }) => {
        const tool: LiveTool = { args, callId: toolCallId, name: toolName, state: "running" };
        return { ...state, live: { ...state.live, tools: [...state.live.tools, tool] } };
      },
      tool_execution_update: ({ toolCallId, partialResult, args }) => {
        // A streamed update may omit the args (they are optional); an
        // absent value keeps the start's args, a present one refreshes.
        const partial = stringifyLive(partialResult);
        const next = args === undefined ? { partial } : { args, partial };
        return {
          ...state,
          live: { ...state.live, tools: foldLiveTool(state.live.tools, toolCallId, next) },
        };
      },
      // Unknown pi events degrade to a named no-op instead of a silent default.
      unhandled: () => state,
    }),
  );
