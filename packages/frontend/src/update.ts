/**
 * The console's update loop (update.ts): pure state transitions returning
 * `[Model, Commands]`. Wire events fold into the live run; `entry_appended`
 * grows the trail; `thread_changed` upserts the rail. The console never
 * computes thread state — the worker broadcasts it (CONTEXT.md: Thread).
 */

import { Match as M } from "effect";
import type { Command } from "foldkit";
import type { ThreadInfo } from "@saku/wire";

import {
  AbortCmd,
  DeleteThreadCmd,
  ListThreadsCmd,
  LoadTrailCmd,
  PromptCmd,
  QuickStartCmd,
  ScrollTrailCmd,
  WireConnectCmd,
} from "./commands.ts";
import { asString, messageText, messageThinking, stringifyLive } from "./format.ts";
import type { AppMessage } from "./message.ts";
import { Model, emptyLive, type LiveTool } from "./model.ts";
import type { EntryProjection, SessionEventProjection } from "./projection.ts";
import { Wire } from "./wire.ts";

export type Commands = ReadonlyArray<Command.Command<AppMessage, never, Wire>>;
export type UpdateReturn = readonly [Model, Commands];

const none: Commands = [];

/** Upsert a thread into the rail (broadcast order is registry order). */
const upsertThread = (threads: ReadonlyArray<ThreadInfo>, thread: ThreadInfo): ThreadInfo[] =>
  threads.some((existing) => existing.id === thread.id)
    ? threads.map((existing) => (existing.id === thread.id ? thread : existing))
    : [...threads, thread];

/** The rail after one thread changed. */
const withThread = (model: Model, thread: ThreadInfo): Model => {
  if (model.rail._tag !== "ready") return model;
  return { ...model, rail: { _tag: "ready", threads: upsertThread(model.rail.threads, thread) } };
};

// -- live run folding -------------------------------------------------------

/** `entry_appended` on the active thread: grow the trail, dedupe by id. */
const foldEntryAppended = (model: Model, entry: EntryProjection): UpdateReturn => {
  if (model.trail._tag !== "ready") return [model, none];
  const last = model.trail.entries[model.trail.entries.length - 1];
  const id = asString(entry.id);
  if (last !== undefined && asString(last.id) === id) return [model, none];
  // A message entry lands complete — the live region's copy of it is stale.
  const live =
    entry.type === "message"
      ? { ...model.live, message: undefined, thinking: undefined }
      : model.live;
  return [
    {
      ...model,
      trail: {
        _tag: "ready",
        entries: [...model.trail.entries, entry],
        tailSeq: Math.max(model.trail.tailSeq, entry.seq ?? 0),
      },
      live,
    },
    [ScrollTrailCmd()],
  ];
};

const foldLiveTool = (
  tools: readonly LiveTool[],
  callId: string,
  next: Partial<LiveTool>,
): LiveTool[] => tools.map((tool) => (tool.callId === callId ? { ...tool, ...next } : tool));

/** The streaming message body shared by `message_start`/`message_end`. */
const liveMessage = (model: Model, text: string): UpdateReturn => [
  { ...model, live: { ...model.live, message: text } },
  [ScrollTrailCmd()],
];

/** The wire's session events for the active thread → live region + trail. */
const foldWireEvent = (model: Model, event: SessionEventProjection): UpdateReturn =>
  M.value(event).pipe(
    M.withReturnType<UpdateReturn>(),
    M.tagsExhaustive({
      entry_appended: ({ entry }) => foldEntryAppended(model, entry),
      message_start: ({ message }) => liveMessage(model, messageText(message)),
      message_end: ({ message }) => liveMessage(model, messageText(message)),
      message_update: ({ message }) => {
        const text = messageText(message);
        const thinking = messageThinking(message);
        return [
          {
            ...model,
            live: {
              ...model.live,
              message: text === "" ? model.live.message : text,
              thinking: thinking === "" ? model.live.thinking : thinking,
            },
          },
          [ScrollTrailCmd()],
        ];
      },
      tool_execution_start: ({ toolCallId, toolName }) => {
        const tool: LiveTool = { callId: toolCallId, name: toolName, state: "running" };
        return [{ ...model, live: { ...model.live, tools: [...model.live.tools, tool] } }, none];
      },
      tool_execution_update: ({ toolCallId, partialResult }) => [
        {
          ...model,
          live: {
            ...model.live,
            tools: foldLiveTool(model.live.tools, toolCallId, {
              partial: stringifyLive(partialResult),
            }),
          },
        },
        none,
      ],
      tool_execution_end: ({ toolCallId, isError, result }) => [
        {
          ...model,
          live: {
            ...model.live,
            tools: foldLiveTool(model.live.tools, toolCallId, {
              state: isError ? "failed" : "done",
              result: stringifyLive(result),
            }),
          },
        },
        none,
      ],
      settled: () => [{ ...model, live: emptyLive() }, none],
      compaction_start: ({ reason }) => [
        { ...model, live: { ...model.live, notice: `compacting (${reason})` } },
        none,
      ],
      compaction_end: () => [{ ...model, live: { ...model.live, notice: undefined } }, none],
      // Unknown pi events degrade to a named no-op instead of a silent default.
      unhandled: () => [model, none],
    }),
  );

// -- update -----------------------------------------------------------------

export const update = (model: Model, message: AppMessage): UpdateReturn =>
  M.value(message).pipe(
    M.withReturnType<UpdateReturn>(),
    M.tagsExhaustive({
      // connection
      WireConnectRequested: () => [model, [WireConnectCmd()]],
      RetryRequested: () => [{ ...model, conn: { _tag: "connecting" } }, [WireConnectCmd()]],
      Connected: ({ hello }) => [
        {
          ...model,
          conn: { _tag: "online", pid: hello.pid, version: hello.version },
          banner: undefined,
        },
        [ListThreadsCmd()],
      ],
      ConnectFailed: ({ message }) => [
        { ...model, conn: { _tag: "offline", error: message } },
        none,
      ],
      ConnectionClosed: () => [
        { ...model, conn: { _tag: "offline", error: "connection closed" } },
        none,
      ],
      ServerErrorNotice: ({ message }) => [{ ...model, banner: message }, none],
      DismissBanner: () => [{ ...model, banner: undefined }, none],

      // rail
      ThreadsListed: ({ threads }) => [{ ...model, rail: { _tag: "ready", threads } }, none],
      ThreadsFailed: ({ message }) => [
        { ...model, rail: { _tag: "failed", error: message } },
        none,
      ],
      RefreshRequested: () => [model, [ListThreadsCmd()]],
      RailInputChanged: ({ text }) => [{ ...model, railInput: text }, none],
      QuickStartRequested: () => {
        const text = model.railInput.trim();
        if (text === "") return [model, none];
        return [{ ...model, railInput: "" }, [QuickStartCmd({ text })]];
      },
      ThreadCreated: ({ thread }) => [
        {
          ...withThread(model, thread),
          active: thread.id,
          trail: { _tag: "loading" },
          live: emptyLive(),
        },
        [LoadTrailCmd({ id: thread.id })],
      ],
      CreateFailed: ({ message }) => [{ ...model, banner: message }, none],
      DeleteRequested: ({ id }) => [model, [DeleteThreadCmd({ id })]],
      ThreadDeleted: ({ id }) => [
        {
          ...model,
          rail:
            model.rail._tag === "ready"
              ? { _tag: "ready", threads: model.rail.threads.filter((t) => t.id !== id) }
              : model.rail,
          active: model.active === id ? null : model.active,
          trail: model.active === id ? { _tag: "loading" } : model.trail,
          live: model.active === id ? emptyLive() : model.live,
        },
        none,
      ],
      DeleteFailed: ({ message }) => [{ ...model, banner: message }, none],

      // the active thread
      SelectRequested: ({ id }) => [
        {
          ...model,
          active: id,
          trail: { _tag: "loading" },
          live: emptyLive(),
        },
        [LoadTrailCmd({ id })],
      ],
      TrailLoaded: ({ id, entries, tailSeq }) =>
        model.active === id
          ? [{ ...model, trail: { _tag: "ready", entries, tailSeq } }, [ScrollTrailCmd()]]
          : [model, none],
      TrailFailed: ({ message }) => [{ ...model, trail: { _tag: "failed", error: message } }, none],

      // composer
      ComposerChanged: ({ text }) => [{ ...model, composer: text }, none],
      SendRequested: () => {
        const text = model.composer.trim();
        if (text === "" || model.active === null) return [model, none];
        return [model, [PromptCmd({ id: model.active, text })]];
      },
      PromptAcked: () => [{ ...model, composer: "" }, none],
      SendFailed: ({ message }) => [{ ...model, banner: message }, none],
      AbortRequested: () =>
        model.active === null ? [model, none] : [model, [AbortCmd({ id: model.active })]],
      AbortDone: () => [model, none],

      // wire events
      WireEvent: ({ threadId, event }) =>
        threadId === model.active ? foldWireEvent(model, event) : [model, none],
      ThreadChanged: ({ thread }) => [withThread(model, thread), none],

      // housekeeping
      ScrollTrail: () => [model, [ScrollTrailCmd()]],
      ScrollDone: () => [model, none],
    }),
  );
