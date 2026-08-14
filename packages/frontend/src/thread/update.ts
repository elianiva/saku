/**
 * The thread submodel's update loop (thread/update.ts): pure state
 * transitions returning `[Model, Commands]`. Session events for the active
 * thread fold through the live state machine (live.ts); `entry_appended`
 * grows the trail there, and a fold that grew the scrollable view fires the
 * scroll command directly (no message round-trip). The pane never computes
 * thread state — the worker broadcasts it (CONTEXT.md: Thread).
 *
 * `informRouteChanged` is the parent's hook for a route change (the
 * informingSubmodels convention, ADR 0009): the root owns the route, the
 * pane derives its state from it. A Thread route pins the id, resets the
 * trail + live run, and re-reads the trail (a fresh selection always loads,
 * matching the pre-routing behavior); the Threads route unpins the id and
 * renders the empty state. The composer survives both — it is user draft,
 * not thread state.
 */

import { Match as M } from "effect";
import { Command } from "foldkit";
import { evo } from "foldkit/struct";

import type { AppRoute } from "../route.ts";
import { Wire } from "../wire.ts";
import { AbortCmd, LoadTrailCmd, PromptCmd, ScrollTrailCmd } from "./command.ts";
import { emptyLiveRegion, foldLive, Trail } from "./live.ts";
import type { ThreadMessage } from "./message.ts";
import { Model } from "./model.ts";

export type Commands = ReadonlyArray<Command.Command<ThreadMessage, never, Wire>>;
export type UpdateReturn = readonly [Model, Commands];
export type RouteChangedReturn = readonly [Model, Commands];

const none: Commands = [];

/** The evo fields for the pane reset when the pinned thread changes. */
const resetViewFields = {
  trail: (_: Model["trail"]) => Trail.Idle(),
  live: (_: Model["live"]) => emptyLiveRegion(),
};

export const update = (model: Model, message: ThreadMessage): UpdateReturn =>
  M.value(message).pipe(
    M.withReturnType<UpdateReturn>(),
    M.tagsExhaustive({
      // A session event for this thread (the root matched the route):
      // fold it through the live state machine; a growing view scrolls.
      SessionEvent: ({ event }) => {
        const [next, scroll] = foldLive({ trail: model.trail, live: model.live }, event);
        return [
          evo(model, { trail: (_) => next.trail, live: (_) => next.live }),
          scroll ? [ScrollTrailCmd()] : none,
        ];
      },
      // The registry's word about this thread: keep the header current
      // (name, mode, state, env — the auto-title lands here).
      ThreadChanged: ({ thread }) =>
        model.id === thread.id ? [evo(model, { info: (_) => thread }), none] : [model, none],

      // trail
      TrailLoaded: ({ entries, tailSeq }) => [
        evo(model, { trail: (_) => Trail.Success({ data: { entries, tailSeq } }) }),
        [ScrollTrailCmd()],
      ],
      TrailFailed: ({ error }) => [evo(model, { trail: (_) => Trail.Failure({ error }) }), none],

      // composer
      ComposerChanged: ({ text }) => [evo(model, { composer: (_) => text }), none],
      SendRequested: () => {
        const text = model.composer.trim();
        if (text === "" || model.id === null) return [model, none];
        return [model, [PromptCmd({ id: model.id, text })]];
      },
      PromptAcked: () => [evo(model, { composer: (_) => "" }), none],
      SendFailed: ({ message }) => [evo(model, { notice: (_) => message }), none],
      AbortRequested: () =>
        model.id === null ? [model, none] : [model, [AbortCmd({ id: model.id })]],
      AbortDone: () => [model, none],

      // housekeeping
      ScrollDone: () => [model, none],
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
        [LoadTrailCmd({ id: route.id })],
      ]
    : [
        evo(model, {
          id: (_) => null,
          info: (_) => null,
          ...resetViewFields,
        }),
        none,
      ];
