/**
 * The live-run state machine (live.ts): the active thread's wire-derived
 * view — the entry trail plus the run in flight — folded as PURE functions.
 *
 * This is the console's most correctness-sensitive logic: the streaming
 * message/tool folds, the complete-entry-clears-streaming-copy invariant,
 * trail dedupe, and the settled reset. It lives here — no foldkit runtime,
 * no DOM, no `Wire` service at module scope — so tests exercise it in
 * isolation. update.ts delegates: wire events for the active thread fold
 * through `foldLive`, which returns the next state plus a scroll flag (the
 * event grew the scrollable view — the TEA loop maps it to the scroll
 * command). Everything else about the console stays in update.ts.
 */

import { Match as M, Schema as S } from "effect";

import { asString, messageText, messageThinking, stringifyLive } from "./format.ts";
import { EntryProjection, type SessionEventProjection } from "./projection.ts";

// -- the active thread's view ----------------------------------------------

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
export const LiveRegion = S.Struct({
  message: S.optional(S.String),
  thinking: S.optional(S.String),
  tools: S.Array(LiveTool),
  notice: S.optional(S.String),
});
export type LiveRegion = S.Schema.Type<typeof LiveRegion>;

/** The active thread's wire-derived view: the trail plus the run in flight. */
export interface Live {
  readonly trail: Trail;
  readonly live: LiveRegion;
}

/** The live region before anything streamed. */
export const emptyLiveRegion = (): LiveRegion => ({ tools: [] });

/**
 * A freshly selected thread: trail loading (the `get_entries` read is in
 * flight), nothing streamed. The trail/live handoff — the live run is
 * absorbed by the trail as entries land, and selecting a thread starts both
 * over.
 */
export const initialLive = (): Live => ({ trail: { _tag: "loading" }, live: emptyLiveRegion() });

// -- folding ----------------------------------------------------------------

/** `entry_appended` on the active thread: grow the trail, dedupe by id. */
const foldEntryAppended = (state: Live, entry: EntryProjection): readonly [Live, boolean] => {
  if (state.trail._tag !== "ready") return [state, false];
  const last = state.trail.entries[state.trail.entries.length - 1];
  const id = asString(entry.id);
  if (last !== undefined && asString(last.id) === id) return [state, false];
  // A message entry lands complete — the live region's copy of it is stale.
  const live =
    entry.type === "message"
      ? { ...state.live, message: undefined, thinking: undefined }
      : state.live;
  return [
    {
      ...state,
      trail: {
        _tag: "ready",
        entries: [...state.trail.entries, entry],
        tailSeq: Math.max(state.trail.tailSeq, entry.seq ?? 0),
      },
      live,
    },
    true,
  ];
};

const foldLiveTool = (
  tools: readonly LiveTool[],
  callId: string,
  next: Partial<LiveTool>,
): LiveTool[] => tools.map((tool) => (tool.callId === callId ? { ...tool, ...next } : tool));

/** The streaming message body shared by `message_start`/`message_end`. */
const messageLive = (state: Live, text: string): Live => ({
  ...state,
  live: { ...state.live, message: text },
});

/**
 * Fold one session event into the active thread's view. Returns the next
 * state and whether the event grew the scrollable view (scroll command in
 * the TEA loop; update.ts maps it). The streamed live region is absorbed by
 * the trail as entries land; `settled` clears the region for the next run.
 */
export const foldLive = (state: Live, event: SessionEventProjection): readonly [Live, boolean] =>
  M.value(event).pipe(
    M.withReturnType<readonly [Live, boolean]>(),
    M.tagsExhaustive({
      entry_appended: ({ entry }) => foldEntryAppended(state, entry),
      message_start: ({ message }) => [messageLive(state, messageText(message)), true],
      message_end: ({ message }) => [messageLive(state, messageText(message)), true],
      message_update: ({ message }) => {
        const text = messageText(message);
        const thinking = messageThinking(message);
        // Partial updates may omit a field; an absent stream keeps its value.
        return [
          {
            ...state,
            live: {
              ...state.live,
              message: text === "" ? state.live.message : text,
              thinking: thinking === "" ? state.live.thinking : thinking,
            },
          },
          true,
        ];
      },
      tool_execution_start: ({ toolCallId, toolName }) => {
        const tool: LiveTool = { callId: toolCallId, name: toolName, state: "running" };
        return [{ ...state, live: { ...state.live, tools: [...state.live.tools, tool] } }, false];
      },
      tool_execution_update: ({ toolCallId, partialResult }) => [
        {
          ...state,
          live: {
            ...state.live,
            tools: foldLiveTool(state.live.tools, toolCallId, {
              partial: stringifyLive(partialResult),
            }),
          },
        },
        false,
      ],
      tool_execution_end: ({ toolCallId, isError, result }) => [
        {
          ...state,
          live: {
            ...state.live,
            tools: foldLiveTool(state.live.tools, toolCallId, {
              state: isError ? "failed" : "done",
              result: stringifyLive(result),
            }),
          },
        },
        false,
      ],
      settled: () => [{ ...state, live: emptyLiveRegion() }, false],
      compaction_start: ({ reason }) => [
        { ...state, live: { ...state.live, notice: `compacting (${reason})` } },
        false,
      ],
      compaction_end: () => [{ ...state, live: { ...state.live, notice: undefined } }, false],
      // Unknown pi events degrade to a named no-op instead of a silent default.
      unhandled: () => [state, false],
    }),
  );
