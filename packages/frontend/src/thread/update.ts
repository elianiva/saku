/**
 * The thread submodel's update loop (thread/update.ts): pure state
 * transitions returning the `[Model, Commands, Option<OutMessage>]` 3-tuple —
 * the OutMessage is how the pane tells the root "a quick start opened this
 * thread" (the root owns navigation). Session events for the active thread
 * fold through the live state machine (live.ts); the trail's chat scroller
 * (scroller.ts) follows the growing view on the DOM side — no scroll
 * commands in the loop (the shadcn message-scroller pattern). The pane
 * never computes thread state — the worker broadcasts it (CONTEXT.md:
 * Thread).
 *
 * The pane owns the quick-start gesture on the welcome (root route): the
 * composer draft is shared between welcome and thread, so `SendRequested`
 * branches on `model.id` — quick start when no thread is pinned, prompt when
 * one is. The draft clears only on success (`ThreadCreated`/`PromptAcked`),
 * so a failed create/send keeps the user's words.
 *
 * `informRouteChanged` is the parent's hook for a route change (the
 * informingSubmodels convention): the root owns the route, the
 * pane derives its state from it. A Thread route pins the id, resets the
 * trail + live run, and re-reads the trail (a fresh selection always loads,
 * matching the pre-routing behavior); the Threads route unpins the id and
 * renders the welcome. The composer survives both — it is user draft, not
 * thread state.
 */

import { Match as M, Option } from "effect";
import type { Command } from "foldkit";
import { evo } from "foldkit/struct";

import type { AppRoute } from "../route.ts";
import { OpenedThread } from "../root/message.ts";
import type { Wire } from "../wire.ts";
import {
  AbortCmd,
  ListModelsCmd,
  LoadStateCmd,
  LoadTrailCmd,
  PromptCmd,
  QuickStartCmd,
  SetModelCmd,
} from "./command.ts";
import { ClearComposerCmd, SetComposerEditableCmd } from "./composer.ts";
import { reduceComposerMenu } from "./composer-menu.ts";
import { emptyLiveRegion, foldLive, foldTrailLoaded, Trail } from "./live.ts";
import { reduceModelPicker } from "./model-picker.ts";
import { NewThreadRequested } from "./message.ts";
import type { ThreadMessage, ThreadOutMessage } from "./message.ts";
import type { Model } from "./model.ts";
import { ModelPicker } from "./model.ts";

export type Commands = readonly Command.Command<ThreadMessage, never, Wire>[];
export type UpdateReturn = readonly [Model, Commands, Option.Option<ThreadOutMessage>];
export type RouteChangedReturn = readonly [Model, Commands];

const none: Commands = [];

/** The evo fields for the pane reset when the pinned thread changes. */
const resetViewFields = {
  composerMenu: (_: Model["composerMenu"]) => null,
  focused: (_: boolean) => false,
  live: (_: Model["live"]) => emptyLiveRegion(),
  model: (_: Model["model"]) => null,
  modelBusy: (_: boolean) => false,
  modelPicker: (_: Model["modelPicker"]) => ModelPicker.Idle(),
  notice: (_: Model["notice"]) => null,
  pickerActive: (_: number) => 0,
  pickerQuery: (_: string) => "",
  thinkingOpen: (_: readonly string[]) => [],
  toolsOpen: (_: readonly string[]) => [],
  // The composer element is fresh on the other surface; its focus state
  // must not leak across routes (the welcome re-focuses via OnMount).
  trail: (_: Model["trail"]) => Trail.Idle(),
  pendingEntries: (_: Model["pendingEntries"]) => [],
  // The floating usage panel is thread-owned too — a fresh selection
  // starts closed.
  usageOpen: (_: boolean) => false,
};

/** The expanded-id set fold shared by the thinking/tool toggles: add on
 *  expand (once), drop on collapse. */
const foldToggled = (ids: readonly string[], id: string, expanded: boolean) => {
  if (!expanded) {
    return ids.filter((x) => x !== id);
  }
  return ids.includes(id) ? ids : [...ids, id];
};

export const update = (model: Model, message: ThreadMessage) =>
  M.value(message).pipe(
    M.withReturnType<UpdateReturn>(),
    M.tagsExhaustive({
      AbortDone: () => [evo(model, { notice: (_) => null }), none, Option.none()],

      AbortFailed: ({ message }) => [evo(model, { notice: (_) => message }), none, Option.none()],

      AbortRequested: () =>
        model.id === null
          ? [model, none, Option.none()]
          : [model, [AbortCmd({ id: model.id })], Option.none()],

      CompactionFailed: ({ message: text }) => [
        evo(model, { notice: (_) => text }),
        none,
        Option.none(),
      ],

      CompactionFinished: () => [evo(model, { notice: (_) => null }), none, Option.none()],

      ComposerBlurred: () => [evo(model, { focused: (_) => false }), none, Option.none()],

      ComposerChanged: ({ text }) => [evo(model, { composer: (_) => text }), none, Option.none()],

      ComposerCleared: () => [model, none, Option.none()],

      ComposerEditableChanged: () => [model, none, Option.none()],

      ComposerFocused: () => [evo(model, { focused: (_) => true }), none, Option.none()],

      // The @// palette: its own slice (composer-menu.ts) owns trigger
      // tracking, navigation, and what a picked suggestion does.
      ComposerMenuClosed: (message) => reduceComposerMenu(model, message),

      ComposerMenuMoved: (message) => reduceComposerMenu(model, message),

      ComposerSuggestionAccepted: (message) => reduceComposerMenu(model, message),

      ComposerSuggestionInserted: () => [model, none, Option.none()],

      ComposerSuggestionPicked: (message) => reduceComposerMenu(model, message),

      ComposerTriggerChanged: (message) => reduceComposerMenu(model, message),

      ComposerTriggerRemoved: () => [model, none, Option.none()],

      // The create failed: release the guard, keep the draft (clear only on
      // success), and show the notice under the composer.
      CreateFailed: ({ message: text }) => [
        evo(model, { notice: (_) => text, starting: (_) => false }),
        [SetComposerEditableCmd({ editable: true, kind: "welcome" })],
        Option.none(),
      ],

      // A row was clicked: the switch is guarded per pick (no double
      // switches; the row shows the in-flight state).
      ModelPicked: ({ provider, modelId }) =>
        model.id === null || model.modelBusy
          ? [model, none, Option.none()]
          : [
              evo(model, { modelBusy: (_) => true }),
              [SetModelCmd({ id: model.id, modelId, provider })],
              Option.none(),
            ],

      ModelPickerClosed: () => [
        evo(model, { modelPicker: (_) => ModelPicker.Idle() }),
        none,
        Option.none(),
      ],

      // Opening is guarded: only on a pinned, non-working thread, and only
      // when closed (the badge is disabled while working — model changes
      // are unavailable mid-run, humanlayer's rule). A fresh open starts
      // unfiltered with the first option highlighted.
      ModelPickerRequested: () =>
        model.id === null || model.info?.state === "working" || model.modelPicker._tag !== "Idle"
          ? [model, none, Option.none()]
          : [
              evo(model, {
                composerMenu: (_) => null,
                modelPicker: (_) => ModelPicker.Loading(),
                pickerActive: (_) => 0,
                pickerQuery: (_) => "",
                // The picker and the usage panel float over the same card
                // edge — only one at a time.
                usageOpen: (_) => false,
              }),
              [ListModelsCmd({ id: model.id })],
              Option.none(),
            ],

      // The switch landed: adopt the resolved model and close; an
      // unresolvable one keeps the picker open and says why.
      ModelSet: (message) => reduceModelPicker(model, message),

      ModelSetFailed: (message) => reduceModelPicker(model, message),

      ModelsListFailed: (message) => reduceModelPicker(model, message),

      ModelsListed: (message) => reduceModelPicker(model, message),

      // The header's new-thread button: surface the fact only on a pinned
      // thread (the welcome needs no button — it is the new thread
      // surface); the root owns URLs and pushes "/".
      NewThreadRequested: () =>
        model.id === null
          ? [model, none, Option.none()]
          : [model, none, Option.some(NewThreadRequested())],

      // ArrowUp/ArrowDown and the search input live in model-picker.ts.
      PickerMove: (message) => reduceModelPicker(model, message),

      PickerQueryChanged: (message) => reduceModelPicker(model, message),

      NoticeDismissed: () => [evo(model, { notice: (_) => null }), none, Option.none()],

      PromptAcked: () => [
        evo(model, { composer: (_) => "", composerMenu: (_) => null, notice: (_) => null }),
        [ClearComposerCmd({ kind: "thread" })],
        Option.none(),
      ],

      SendFailed: ({ message: text }) => [
        evo(model, { notice: (_) => text }),
        model.id === null
          ? none
          : [SetComposerEditableCmd({ editable: model.info?.state !== "working", kind: "thread" })],
        Option.none(),
      ],

      // The one send path: Enter and the send/start button both land here.
      // No thread pinned → the welcome's quick start (CONTEXT.md: Quick
      // start); pinned → prompt the thread. The starting guard ignores
      // Enter while a create is in flight (no double threads).
      SendRequested: () => {
        const text = model.composer.trim();
        if (text === "") {
          return [model, none, Option.none()];
        }
        if (model.id === null) {
          if (model.starting) {
            return [model, none, Option.none()];
          }
          return [
            evo(model, { composerMenu: (_) => null, starting: (_) => true }),
            [SetComposerEditableCmd({ editable: false, kind: "welcome" }), QuickStartCmd({ text })],
            Option.none(),
          ];
        }
        if (model.info?.state === "working") {
          return [model, none, Option.none()];
        }
        return [model, [PromptCmd({ id: model.id, text })], Option.none()];
      },

      // A session event for this thread (the root matched the route):
      // fold it through the live state machine; the trail's chat scroller
      // observes the growth on the DOM side.
      SessionEvent: ({ event }) => {
        const next = foldLive(
          { live: model.live, pending: model.pendingEntries, trail: model.trail },
          event,
        );
        return [
          evo(model, {
            live: (_) => next.live,
            pendingEntries: (_) => [...next.pending],
            trail: (_) => next.trail,
          }),
          none,
          Option.none(),
        ];
      },

      StateFailed: ({ error }) => [evo(model, { notice: (_) => error }), none, Option.none()],

      // The badge's model read (and the header's info) landed: adopt the
      // model, adopt the info so a thread opened mid-run shows its state
      // and the stop control immediately, and clear a stale read failure.
      StateLoaded: ({ model: next, info }) => [
        evo(model, { info: (_) => info, model: (_) => next, notice: (_) => null }),
        [SetComposerEditableCmd({ editable: info.state !== "working", kind: "thread" })],
        Option.none(),
      ],

      // A trail thinking block was expanded/collapsed (the `<details>`
      // toggle event; `expanded` is the new state from OnToggle). The
      // live region never lands here — it is open while streaming.
      ThinkingToggled: ({ messageId, expanded }) => [
        evo(model, { thinkingOpen: (ids) => foldToggled(ids, messageId, expanded) }),
        none,
        Option.none(),
      ],

      // The registry's word about this thread: keep the header current
      // (name, mode, state, env — the auto-title lands here).
      ThreadChanged: ({ thread }) => {
        if (model.id !== thread.id) {
          return [model, none, Option.none()];
        }
        return [
          evo(model, { info: (_) => thread }),
          [SetComposerEditableCmd({ editable: thread.state !== "working", kind: "thread" })],
          Option.none(),
        ];
      },

      // A thread was born from the draft: clear the draft (the prompt was
      // consumed), release the guard, and surface the fact — the root
      // pushes its URL, exactly as if the user had clicked the rail row.
      ThreadCreated: ({ thread }) => [
        evo(model, {
          composer: (_) => "",
          composerMenu: (_) => null,
          focused: (_) => false,
          notice: (_) => null,
          starting: (_) => false,
        }),
        [ClearComposerCmd({ kind: "welcome" })],
        Option.some(OpenedThread({ id: thread.id })),
      ],

      // A tool row (trail call chip, tool result, or live tool) was
      // expanded/collapsed — same fold, keyed by the call or entry id.
      ToolToggled: ({ id, expanded }) => [
        evo(model, { toolsOpen: (ids) => foldToggled(ids, id, expanded) }),
        none,
        Option.none(),
      ],

      TrailFailed: ({ error }) => [
        evo(model, { trail: (_) => Trail.Failure({ error }) }),
        none,
        Option.none(),
      ],

      TrailLoaded: ({ entries, tailSeq }) => {
        const next = foldTrailLoaded(
          { live: model.live, pending: model.pendingEntries, trail: model.trail },
          entries,
          tailSeq,
        );
        return [
          evo(model, {
            live: (_) => next.live,
            pendingEntries: (_) => [...next.pending],
            trail: (_) => next.trail,
          }),
          none,
          Option.none(),
        ];
      },

      UsagePanelClosed: () => [evo(model, { usageOpen: (_) => false }), none, Option.none()],

      // The context badge toggles the floating usage panel; the close
      // button and Escape (view.ts) close it.
      UsagePanelRequested: () => [
        evo(model, { usageOpen: (_) => !model.usageOpen }),
        none,
        Option.none(),
      ],
    }),
  );

/** The root's hook for a route change (the informing convention).
 *
 * `connected` gates the pane's reads: issued only when the wire is online —
 * a read fired while connecting races the handshake and fails (the boot
 * double-fetch, the TrailFailed flash). When offline or still connecting,
 * no commands ride along; the conn machine's Online transition re-issues
 * them, incrementally.
 */
export const informRouteChanged = (
  model: Model,
  route: AppRoute,
  connected: boolean,
): RouteChangedReturn => {
  const loads = (id: string) => [LoadTrailCmd({ id }), LoadStateCmd({ id })];
  return route._tag === "Thread"
    ? [
        evo(model, {
          id: (_) => route.id,
          info: (_) => null,
          ...resetViewFields,
        }),
        connected ? loads(route.id) : none,
      ]
    : [
        evo(model, {
          id: (_) => null,
          info: (_) => null,
          ...resetViewFields,
        }),
        none,
      ];
};
