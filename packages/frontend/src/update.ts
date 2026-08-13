/**
 * The console's update loop (update.ts): pure state transitions returning
 * `[Model, Commands]`. Wire events for the active thread fold through the
 * live state machine (live.ts); `entry_appended` grows the trail there;
 * `thread_changed` upserts the rail. The console never computes thread
 * state — the worker broadcasts it (CONTEXT.md: Thread).
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
import { foldLive, initialLive } from "./live.ts";
import type { AppMessage } from "./message.ts";
import { Model } from "./model.ts";
import type { SessionEventProjection } from "./projection.ts";
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

/** Wire events for the active thread fold through the live state machine. */
const foldActive = (model: Model, event: SessionEventProjection): UpdateReturn => {
  const [next, scroll] = foldLive({ trail: model.trail, live: model.live }, event);
  return [
    { ...model, trail: next.trail, live: next.live },
    scroll ? [ScrollTrailCmd()] : none,
  ];
};

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
          ...initialLive(),
        },
        [LoadTrailCmd({ id: thread.id })],
      ],
      CreateFailed: ({ message }) => [{ ...model, banner: message }, none],
      DeleteRequested: ({ id }) => [model, [DeleteThreadCmd({ id })]],
      ThreadDeleted: ({ id }) => {
        const removed = model.active === id;
        const view = removed ? initialLive() : { trail: model.trail, live: model.live };
        return [
          {
            ...model,
            rail:
              model.rail._tag === "ready"
                ? { _tag: "ready", threads: model.rail.threads.filter((t) => t.id !== id) }
                : model.rail,
            active: removed ? null : model.active,
            ...view,
          },
          none,
        ];
      },
      DeleteFailed: ({ message }) => [{ ...model, banner: message }, none],

      // the active thread
      SelectRequested: ({ id }) => [
        {
          ...model,
          active: id,
          ...initialLive(),
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
        threadId === model.active ? foldActive(model, event) : [model, none],
      ThreadChanged: ({ thread }) => [withThread(model, thread), none],

      // housekeeping
      ScrollTrail: () => [model, [ScrollTrailCmd()]],
      ScrollDone: () => [model, none],
    }),
  );
