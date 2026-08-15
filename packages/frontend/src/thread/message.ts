/**
 * The thread submodel's message union (thread/message.ts). These are
 * internal to the pane — the root sees them wrapped as `GotThreadMessage`.
 * The session events the wire streams for this thread arrive root-routed as
 * `SessionEvent` (the root matched the thread id against the route), and the
 * registry broadcasts arrive as `ThreadChanged` (keeps the header's
 * name/state/env current, e.g. after an auto-title).
 *
 * The pane also owns the quick-start gesture (CONTEXT.md: Quick start) —
 * the welcome composer on the root route. The gesture shares the composer
 * draft with the thread prompt; `SendRequested` means quick start when no
 * thread is pinned and prompt when one is.
 */

import { Schema as S } from "effect";
import { Message } from "foldkit";
import { PiSessionInfo, ThreadInfo, WireError, WireModelInfo } from "@saku/wire";

import type { OpenedThread } from "../root/message.ts";
import { EntryProjection, SessionEventProjection } from "./projection.ts";

/** A session event landed for this thread (root routed it by thread id). */
export const SessionEvent = Message.m("SessionEvent", { event: SessionEventProjection });
/** The registry broadcast for this thread — the header's info refresh. */
export const ThreadChanged = Message.m("ThreadChanged", { thread: ThreadInfo });

/** The trail read landed (a LoadTrail result). */
export const TrailLoaded = Message.m("TrailLoaded", {
  entries: S.Array(EntryProjection),
  tailSeq: S.Number,
});
export const TrailFailed = Message.m("TrailFailed", { error: S.String });

export const ComposerChanged = Message.m("ComposerChanged", { text: S.String });
/** Enter / the send button: prompts the pinned thread, or quick-starts a new
 *  one when no thread is pinned (the update branches on `model.id`). */
export const SendRequested = Message.m("SendRequested");
export const PromptAcked = Message.m("PromptAcked");
export const SendFailed = Message.m("SendFailed", { message: S.String });
/** The composer's focus state, for the focus-aware placeholder (the
 *  humanlayer pattern: unfocused shows the affordance, focused the task). */
export const ComposerFocused = Message.m("ComposerFocused");
export const ComposerBlurred = Message.m("ComposerBlurred");

/** The pinned thread's state read landed — the model badge's model. */
export const StateLoaded = Message.m("StateLoaded", { model: S.NullOr(WireModelInfo) });
export const StateFailed = Message.m("StateFailed");

/** The composer's model badge was clicked: open the picker. */
export const ModelPickerRequested = Message.m("ModelPickerRequested");
/** The daemon's answer: the models this thread can switch to. */
export const ModelsListed = Message.m("ModelsListed", { models: S.Array(WireModelInfo) });
export const ModelsListFailed = Message.m("ModelsListFailed", { error: WireError });
/** A picker row was clicked: switch the thread's model. */
export const ModelPicked = Message.m("ModelPicked", {
  provider: S.String,
  modelId: S.String,
});
/** The switch landed (null: the model did not resolve). */
export const ModelSet = Message.m("ModelSet", { model: S.NullOr(WireModelInfo) });
export const ModelSetFailed = Message.m("ModelSetFailed", { message: S.String });
/** The picker's close button. */
export const ModelPickerClosed = Message.m("ModelPickerClosed");

/** The quick-start command landed: a thread was born from the draft. */
export const ThreadCreated = Message.m("ThreadCreated", { thread: ThreadInfo });
export const CreateFailed = Message.m("CreateFailed", { message: S.String });

/** The welcome's "from pi…" affordance was clicked: open the picker. */
export const PiSessionsRequested = Message.m("PiSessionsRequested");
/** The local daemon's answer: pi's sessions on this machine. */
export const PiSessionsListed = Message.m("PiSessionsListed", {
  sessions: S.Array(PiSessionInfo),
});
export const PiSessionsListFailed = Message.m("PiSessionsListFailed", { error: WireError });
/** A picker row was clicked: adopt that pi session as a thread. */
export const PiImportRequested = Message.m("PiImportRequested", { path: S.String });
/** The import landed: a thread was born from the pi session. */
export const PiImported = Message.m("PiImported", { thread: ThreadInfo });
export const PiImportFailed = Message.m("PiImportFailed", { error: WireError });
/** The picker's close button. */
export const PiPickerClosed = Message.m("PiPickerClosed");

export const AbortRequested = Message.m("AbortRequested");
export const AbortDone = Message.m("AbortDone");

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
  ComposerFocused,
  ComposerBlurred,
  StateLoaded,
  StateFailed,
  ModelPickerRequested,
  ModelsListed,
  ModelsListFailed,
  ModelPicked,
  ModelSet,
  ModelSetFailed,
  ModelPickerClosed,
  ThreadCreated,
  CreateFailed,
  PiSessionsRequested,
  PiSessionsListed,
  PiSessionsListFailed,
  PiImportRequested,
  PiImported,
  PiImportFailed,
  PiPickerClosed,
  AbortRequested,
  AbortDone,
  ScrollDone,
]);
export type ThreadMessage = S.Schema.Type<typeof ThreadMessage>;

/**
 * The fact the pane surfaces to the root (the informing convention, ADR
 * 0009): a quick start opened a thread — the root pushes its URL, exactly
 * as if the user had clicked the rail row.
 */
export type ThreadOutMessage = typeof OpenedThread.Type;
