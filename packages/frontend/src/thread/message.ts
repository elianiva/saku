/**
 * The thread submodel's message union (thread/message.ts). These are
 * internal to the pane — the root sees them wrapped as `GotThreadMessage`.
 * The session events the wire streams for this thread arrive root-routed as
 * `SessionEvent` (the root matched the thread id against the route), and the
 * registry broadcasts arrive as `ThreadChanged` (keeps the header's
 * name/state/env current, e.g. after an auto-title).
 */

import { Schema as S } from "effect";
import { Message } from "foldkit";
import { ThreadInfo } from "@saku/wire";

import { EntryProjection, SessionEventProjection } from "./projection.ts";

// -- wire bridge (root-delegated) ------------------------------------------

/** A session event landed for this thread (root routed it by thread id). */
export const SessionEvent = Message.m("SessionEvent", { event: SessionEventProjection });
/** The registry broadcast for this thread — the header's info refresh. */
export const ThreadChanged = Message.m("ThreadChanged", { thread: ThreadInfo });

// -- trail -----------------------------------------------------------------

/** The trail read landed (a LoadTrail result). */
export const TrailLoaded = Message.m("TrailLoaded", {
  entries: S.Array(EntryProjection),
  tailSeq: S.Number,
});
export const TrailFailed = Message.m("TrailFailed", { error: S.String });

// -- composer ---------------------------------------------------------------

export const ComposerChanged = Message.m("ComposerChanged", { text: S.String });
export const SendRequested = Message.m("SendRequested");
export const PromptAcked = Message.m("PromptAcked");
export const SendFailed = Message.m("SendFailed", { message: S.String });
export const AbortRequested = Message.m("AbortRequested");
export const AbortDone = Message.m("AbortDone");

// -- housekeeping -----------------------------------------------------------

/** The scroll command's landing (the DOM touch happened). */
export const ScrollDone = Message.m("ScrollDone");

export const ThreadMessage = S.Union([
  SessionEvent,
  ThreadChanged,
  TrailLoaded,
  TrailFailed,
  ComposerChanged,
  SendRequested,
  PromptAcked,
  SendFailed,
  AbortRequested,
  AbortDone,
  ScrollDone,
]);
export type ThreadMessage = S.Schema.Type<typeof ThreadMessage>;
