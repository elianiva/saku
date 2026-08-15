/**
 * The thread submodel's update loop (thread/update.ts): pure state
 * transitions returning the `[Model, Commands, Option<OutMessage>]` 3-tuple —
 * the OutMessage is how the pane tells the root "a quick start opened this
 * thread" (the root owns navigation). Session events for the active thread
 * fold through the live state machine (live.ts); `entry_appended` grows the
 * trail there, and a fold that grew the scrollable view fires the scroll
 * command directly (no message round-trip). The pane never computes thread
 * state — the worker broadcasts it (CONTEXT.md: Thread).
 *
 * The pane owns the quick-start gesture on the welcome (root route): the
 * composer draft is shared between welcome and thread, so `SendRequested`
 * branches on `model.id` — quick start when no thread is pinned, prompt when
 * one is. The draft clears only on success (`ThreadCreated`/`PromptAcked`),
 * so a failed create/send keeps the user's words.
 *
 * `informRouteChanged` is the parent's hook for a route change (the
 * informingSubmodels convention, ADR 0009): the root owns the route, the
 * pane derives its state from it. A Thread route pins the id, resets the
 * trail + live run, and re-reads the trail (a fresh selection always loads,
 * matching the pre-routing behavior); the Threads route unpins the id and
 * renders the welcome. The composer survives both — it is user draft, not
 * thread state.
 */

import { Match as M, Option } from "effect";
import { Command } from "foldkit";
import { evo } from "foldkit/struct";

import type { AppRoute } from "../route.ts";
import { OpenedThread } from "../root/message.ts";
import { Wire } from "../wire.ts";
import {
  AbortCmd,
  ImportPiSessionCmd,
  ListModelsCmd,
  ListPiSessionsCmd,
  LoadStateCmd,
  LoadTrailCmd,
  PromptCmd,
  QuickStartCmd,
  ScrollTrailCmd,
  SetModelCmd,
} from "./command.ts";
import { emptyLiveRegion, foldLive, Trail } from "./live.ts";
import type { ThreadMessage, ThreadOutMessage } from "./message.ts";
import { Model, ModelPicker, PiPicker } from "./model.ts";

export type Commands = ReadonlyArray<Command.Command<ThreadMessage, never, Wire>>;
export type UpdateReturn = readonly [Model, Commands, Option.Option<ThreadOutMessage>];
export type RouteChangedReturn = readonly [Model, Commands];

const none: Commands = [];

/** The evo fields for the pane reset when the pinned thread changes. */
const resetViewFields = {
  trail: (_: Model["trail"]) => Trail.Idle(),
  live: (_: Model["live"]) => emptyLiveRegion(),
  // The composer element is fresh on the other surface; its focus state
  // must not leak across routes (the welcome re-focuses via OnMount).
  focused: (_: boolean) => false,
  // Model badge state is thread-owned; the welcome has no model to show.
  model: (_: Model["model"]) => null,
  modelPicker: (_: Model["modelPicker"]) => ModelPicker.Idle(),
  modelBusy: (_: boolean) => false,
};

export const update = (model: Model, message: ThreadMessage) =>
  M.value(message).pipe(
    M.withReturnType<UpdateReturn>(),
    M.tagsExhaustive({
      // A session event for this thread (the root matched the route):
      // fold it through the live state machine; a growing view scrolls.
      SessionEvent: ({ event }) => {
        const [next, scroll] = foldLive({ trail: model.trail, live: model.live }, event);
        return [
          evo(model, { trail: (_) => next.trail, live: (_) => next.live }),
          scroll ? [ScrollTrailCmd({ force: false })] : none,
          Option.none(),
        ];
      },
      // The registry's word about this thread: keep the header current
      // (name, mode, state, env — the auto-title lands here).
      ThreadChanged: ({ thread }) =>
        model.id === thread.id
          ? [evo(model, { info: (_) => thread }), none, Option.none()]
          : [model, none, Option.none()],

      TrailLoaded: ({ entries, tailSeq }) => [
        evo(model, { trail: (_) => Trail.Success({ data: { entries, tailSeq } }) }),
        [ScrollTrailCmd({ force: true })],
        Option.none(),
      ],
      TrailFailed: ({ error }) => [
        evo(model, { trail: (_) => Trail.Failure({ error }) }),
        none,
        Option.none(),
      ],

      ComposerChanged: ({ text }) => [evo(model, { composer: (_) => text }), none, Option.none()],
      ComposerFocused: () => [evo(model, { focused: (_) => true }), none, Option.none()],
      ComposerBlurred: () => [evo(model, { focused: (_) => false }), none, Option.none()],

      // The badge's model read: land it, or stay with the current value
      // (a failed read keeps the badge's last-known model; null until then).
      StateLoaded: ({ model: next }) => [evo(model, { model: (_) => next }), none, Option.none()],
      StateFailed: () => [model, none, Option.none()],

      // Opening is guarded: only on a pinned, non-working thread, and only
      // when closed (the badge is disabled while working — model changes
      // are unavailable mid-run, humanlayer's rule).
      ModelPickerRequested: () =>
        model.id === null || model.info?.state === "working" || model.modelPicker._tag !== "Idle"
          ? [model, none, Option.none()]
          : [
              evo(model, { modelPicker: (_) => ModelPicker.Loading() }),
              [ListModelsCmd({ id: model.id })],
              Option.none(),
            ],
      ModelsListed: ({ models }) => [
        evo(model, { modelPicker: (_) => ModelPicker.Success({ data: models }) }),
        none,
        Option.none(),
      ],
      ModelsListFailed: ({ error }) => [
        evo(model, { modelPicker: (_) => ModelPicker.Failure({ error }) }),
        none,
        Option.none(),
      ],
      // A row was clicked: the switch is guarded per pick (no double
      // switches; the row shows the in-flight state).
      ModelPicked: ({ provider, modelId }) =>
        model.id === null || model.modelBusy
          ? [model, none, Option.none()]
          : [
              evo(model, { modelBusy: (_) => true }),
              [SetModelCmd({ id: model.id, provider, modelId })],
              Option.none(),
            ],
      // The switch landed: adopt the resolved model and close the picker.
      // A null resolution (the model did not resolve) keeps the picker open
      // and says why.
      ModelSet: ({ model: next }) =>
        next === null
          ? [
              evo(model, { modelBusy: (_) => false, notice: (_) => "model unavailable" }),
              none,
              Option.none(),
            ]
          : [
              evo(model, {
                model: (_) => next,
                modelBusy: (_) => false,
                modelPicker: (_) => ModelPicker.Idle(),
              }),
              none,
              Option.none(),
            ],
      ModelSetFailed: ({ message }) => [
        evo(model, { modelBusy: (_) => false, notice: (_) => message }),
        none,
        Option.none(),
      ],
      ModelPickerClosed: () => [
        evo(model, { modelPicker: (_) => ModelPicker.Idle() }),
        none,
        Option.none(),
      ],
      // The one send path: Enter and the send/start button both land here.
      // No thread pinned → the welcome's quick start (CONTEXT.md: Quick
      // start); pinned → prompt the thread. The starting guard ignores
      // Enter while a create is in flight (no double threads).
      SendRequested: () => {
        const text = model.composer.trim();
        if (text === "") return [model, none, Option.none()];
        if (model.id === null) {
          if (model.starting) return [model, none, Option.none()];
          return [evo(model, { starting: (_) => true }), [QuickStartCmd({ text })], Option.none()];
        }
        return [model, [PromptCmd({ id: model.id, text })], Option.none()];
      },
      PromptAcked: () => [evo(model, { composer: (_) => "" }), none, Option.none()],
      SendFailed: ({ message }) => [evo(model, { notice: (_) => message }), none, Option.none()],

      // A thread was born from the draft: clear the draft (the prompt was
      // consumed), release the guard, and surface the fact — the root
      // pushes its URL, exactly as if the user had clicked the rail row.
      ThreadCreated: ({ thread }) => [
        evo(model, { starting: (_) => false, composer: (_) => "", focused: (_) => false }),
        none,
        Option.some(OpenedThread({ id: thread.id })),
      ],
      // The create failed: release the guard, keep the draft (clear only on
      // success), and show the notice under the composer.
      CreateFailed: ({ message }) => [
        evo(model, { starting: (_) => false, notice: (_) => message }),
        none,
        Option.none(),
      ],

      // Opening is guarded: only on the welcome, and only when closed.
      PiSessionsRequested: () =>
        model.id !== null || model.piPicker._tag !== "Idle"
          ? [model, none, Option.none()]
          : [evo(model, { piPicker: (_) => PiPicker.Loading() }), [ListPiSessionsCmd()], Option.none()],
      PiSessionsListed: ({ sessions }) => [
        evo(model, { piPicker: (_) => PiPicker.Success({ data: sessions }) }),
        none,
        Option.none(),
      ],
      PiSessionsListFailed: ({ error }) => [
        evo(model, { piPicker: (_) => PiPicker.Failure({ error }) }),
        none,
        Option.none(),
      ],
      // A row was clicked: import is guarded per path (no double imports).
      PiImportRequested: ({ path }) =>
        model.importing !== null
          ? [model, none, Option.none()]
          : [evo(model, { importing: (_) => path }), [ImportPiSessionCmd({ path })], Option.none()],
      // The import landed: a thread was born from the pi session — surface
      // the fact (the root pushes its URL, like a quick start) and reset.
      PiImported: ({ thread }) => [
        evo(model, {
          importing: (_) => null,
          piPicker: (_) => PiPicker.Idle(),
          focused: (_) => false,
        }),
        none,
        Option.some(OpenedThread({ id: thread.id })),
      ],
      PiImportFailed: ({ error }) => [
        evo(model, { importing: (_) => null, notice: (_) => error.message }),
        none,
        Option.none(),
      ],
      PiPickerClosed: () => [
        evo(model, { piPicker: (_) => PiPicker.Idle() }),
        none,
        Option.none(),
      ],

      AbortRequested: () =>
        model.id === null
          ? [model, none, Option.none()]
          : [model, [AbortCmd({ id: model.id })], Option.none()],
      AbortDone: () => [model, none, Option.none()],

      ScrollDone: () => [model, none, Option.none()],
    }),
  );

/** The root's hook for a route change (ADR 0009's informing convention). */
export const informRouteChanged = (model: Model, route: AppRoute): RouteChangedReturn =>
  route._tag === "Thread"
    ? [
        evo(model, {
          id: (_) => route.id,
          info: (_) => null,
          ...resetViewFields,
        }),
        [LoadTrailCmd({ id: route.id }), LoadStateCmd({ id: route.id })],
      ]
    : [
        evo(model, {
          id: (_) => null,
          info: (_) => null,
          ...resetViewFields,
        }),
        none,
      ];
