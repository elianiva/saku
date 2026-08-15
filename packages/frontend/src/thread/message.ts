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
import { ThreadInfo, WireError, WireModelInfo } from "@saku/wire";

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
/** Lexical found a trigger immediately before the caret. The suggestion
 *  surface is Foldkit-owned; Lexical only reports the cursor context. */
export const ComposerTriggerChanged = Message.m("ComposerTriggerChanged", {
  trigger: S.Literals(["file", "command"]),
  query: S.String,
});
export const ComposerMenuClosed = Message.m("ComposerMenuClosed");
export const ComposerMenuMoved = Message.m("ComposerMenuMoved", { delta: S.Number });
export const ComposerSuggestionAccepted = Message.m("ComposerSuggestionAccepted");
export const ComposerSuggestionPicked = Message.m("ComposerSuggestionPicked", {
  trigger: S.Literals(["file", "command"]),
  value: S.String,
});
/** Fire-and-forget acknowledgements for DOM work performed by the Lexical
 *  Mount. They keep those effects visible to Foldkit's runtime and DevTools. */
export const ComposerCleared = Message.m("ComposerCleared");
export const ComposerTriggerRemoved = Message.m("ComposerTriggerRemoved");
export const ComposerSuggestionInserted = Message.m("ComposerSuggestionInserted");
export const ComposerEditableChanged = Message.m("ComposerEditableChanged");
/** Enter / the send button: prompts the pinned thread, or quick-starts a new
 *  one when no thread is pinned (the update branches on `model.id`). */
export const SendRequested = Message.m("SendRequested");
export const PromptAcked = Message.m("PromptAcked");
export const SendFailed = Message.m("SendFailed", { message: S.String });
export const CompactionFinished = Message.m("CompactionFinished");
export const CompactionFailed = Message.m("CompactionFailed", { message: S.String });
/** The composer's focus state, for the focus-aware placeholder (the
 *  humanlayer pattern: unfocused shows the affordance, focused the task). */
export const ComposerFocused = Message.m("ComposerFocused");
export const ComposerBlurred = Message.m("ComposerBlurred");

/** The pinned thread's state read landed — the model badge's model and the
 *  header's info (a thread opened mid-run must show its state and the stop
 *  control immediately, not after the next broadcast). */
export const StateLoaded = Message.m("StateLoaded", {
  model: S.NullOr(WireModelInfo),
  info: ThreadInfo,
});
export const StateFailed = Message.m("StateFailed");

/** The composer's model badge was clicked: open the picker. */
export const ModelPickerRequested = Message.m("ModelPickerRequested");
/** The daemon's answer: the models this thread can switch to. */
export const ModelsListed = Message.m("ModelsListed", { models: S.Array(WireModelInfo) });
export const ModelsListFailed = Message.m("ModelsListFailed", { error: WireError });
/** The picker's search input changed: filter the model list. */
export const PickerQueryChanged = Message.m("PickerQueryChanged", { text: S.String });
/** ArrowUp/ArrowDown in the picker: move the highlighted option (delta ±1). */
export const PickerMove = Message.m("PickerMove", { delta: S.Number });
/** A picker row was clicked (or Enter on the highlighted one): switch the
 *  thread's model. */
export const ModelPicked = Message.m("ModelPicked", {
  provider: S.String,
  modelId: S.String,
});
/** The switch landed (null: the model did not resolve). */
export const ModelSet = Message.m("ModelSet", { model: S.NullOr(WireModelInfo) });
export const ModelSetFailed = Message.m("ModelSetFailed", { message: S.String });
/** The picker's close button. */
export const ModelPickerClosed = Message.m("ModelPickerClosed");

/** The context badge was clicked: toggle the floating usage panel. */
export const UsagePanelRequested = Message.m("UsagePanelRequested");
/** The usage panel's close button / Escape. */
export const UsagePanelClosed = Message.m("UsagePanelClosed");

/** The quick-start command landed: a thread was born from the draft. */
export const ThreadCreated = Message.m("ThreadCreated", { thread: ThreadInfo });
export const CreateFailed = Message.m("CreateFailed", { message: S.String });

export const AbortRequested = Message.m("AbortRequested");
export const AbortDone = Message.m("AbortDone");

/** The header's new-thread button: leave the pinned thread for the
 *  welcome — the root pushes "/" (the quick-start composer is the new
 *  thread surface, CONTEXT.md: Quick start). */
export const NewThreadRequested = Message.m("NewThreadRequested");

/** A thinking block was toggled (the `<details>`'s native toggle event). */
export const ThinkingToggled = Message.m("ThinkingToggled", {
  messageId: S.String,
  expanded: S.Boolean,
});

/** A tool row was toggled (the `<details>`'s native toggle event). */
export const ToolToggled = Message.m("ToolToggled", {
  id: S.String,
  expanded: S.Boolean,
});

export const ThreadMessage = S.Union([
  SessionEvent,
  ThreadChanged,
  TrailLoaded,
  TrailFailed,
  ComposerChanged,
  ComposerTriggerChanged,
  ComposerMenuClosed,
  ComposerMenuMoved,
  ComposerSuggestionAccepted,
  ComposerSuggestionPicked,
  ComposerCleared,
  ComposerTriggerRemoved,
  ComposerSuggestionInserted,
  ComposerEditableChanged,
  SendRequested,
  PromptAcked,
  SendFailed,
  CompactionFinished,
  CompactionFailed,
  ComposerFocused,
  ComposerBlurred,
  StateLoaded,
  StateFailed,
  ModelPickerRequested,
  ModelsListed,
  ModelsListFailed,
  PickerQueryChanged,
  PickerMove,
  ModelPicked,
  ModelSet,
  ModelSetFailed,
  ModelPickerClosed,
  UsagePanelRequested,
  UsagePanelClosed,
  ThreadCreated,
  CreateFailed,
  AbortRequested,
  AbortDone,
  NewThreadRequested,
  ThinkingToggled,
  ToolToggled,
]);
export type ThreadMessage = S.Schema.Type<typeof ThreadMessage>;

/**
 * The facts the pane surfaces to the root (the informing convention, ADR
 * 0009): a quick start opened a thread — the root pushes its URL, exactly
 * as if the user had clicked the rail row — and the header's new-thread
 * button asked for the welcome — the root pushes "/". The root owns URLs.
 */
export type ThreadOutMessage =
  | typeof OpenedThread.Type
  | typeof NewThreadRequested.Type;
