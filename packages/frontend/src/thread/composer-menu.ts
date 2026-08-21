/**
 * The composer menu's update slice (composer-menu.ts): the @// trigger
 * palette — trigger tracking, arrow navigation, and what a picked
 * suggestion does — as one pure reducer over the pane's model. Split from
 * thread/update.ts along its seam: the menu's tags touch only
 * `composerMenu` and the actions a picked suggestion names.
 */

import { Match as M, Option } from "effect";

import {
  AbortCmd,
  CompactCmd,
  ListModelsCmd,
} from "./command.ts";
import { ClearComposerCmd, InsertComposerSuggestionCmd, RemoveComposerTriggerCmd } from "./composer.ts";
import { composerSuggestions } from "./composer/options.ts";
import type { ComposerSuggestion, ComposerTrigger } from "./composer/options.ts";
import { ModelPicker } from "./model.ts";
import type { ThreadMessage } from "./message.ts";
import type { Model } from "./model.ts";
import type { Commands, UpdateReturn } from "./update.ts";

const none: Commands = [];

/** The tags this slice owns; each maps to exactly one arm below. */
export type ComposerMenuMessage = Extract<
  ThreadMessage,
  { readonly _tag: "ComposerTriggerChanged" | "ComposerMenuClosed" | "ComposerMenuMoved" | "ComposerSuggestionAccepted" | "ComposerSuggestionPicked" }
>;

const composerKind = (model: Model) => (model.id === null ? "welcome" : "thread");

const options = (model: Model, trigger: ComposerTrigger, query: string) =>
  composerSuggestions(trigger, query, model.id !== null);

const closeComposerMenu = (next: Model): UpdateReturn => [
  { ...next, composerMenu: null },
  none,
  Option.none(),
];

/** Apply a picked suggestion; the switch covers the suggestion action's
 *  closed union — no default arm, so a new action is a compile error here
 *  instead of a silent no-op (the exact pattern docs/style.md bans). */
const applySuggestion = (
  model: Model,
  trigger: ComposerTrigger,
  suggestion: ComposerSuggestion,
): UpdateReturn => {
  const kind = composerKind(model);
  switch (suggestion.action) {
    case "mention": {
      const [closed] = closeComposerMenu(model);
      return [
        closed,
        [InsertComposerSuggestionCmd({ kind, trigger, value: suggestion.value })],
        Option.none(),
      ];
    }
    case "clear": {
      const [closed] = closeComposerMenu(model);
      return [closed, [ClearComposerCmd({ kind })], Option.none()];
    }
    case "model": {
      if (model.id === null) {
        return [model, none, Option.none()];
      }
      const [closed] = closeComposerMenu(model);
      return [
        {
          ...closed,
          modelPicker: ModelPicker.Loading(),
          pickerActive: 0,
          pickerQuery: "",
          usageOpen: false,
        },
        [RemoveComposerTriggerCmd({ kind, trigger }), ListModelsCmd({ id: model.id })],
        Option.none(),
      ];
    }
    case "compact": {
      if (model.id === null) {
        return [model, none, Option.none()];
      }
      const [closed] = closeComposerMenu(model);
      return [
        closed,
        [RemoveComposerTriggerCmd({ kind, trigger }), CompactCmd({ id: model.id })],
        Option.none(),
      ];
    }
    case "abort": {
      if (model.id === null) {
        return [model, none, Option.none()];
      }
      const [closed] = closeComposerMenu(model);
      return [
        closed,
        [RemoveComposerTriggerCmd({ kind, trigger }), AbortCmd({ id: model.id })],
        Option.none(),
      ];
    }
  }
};

/** Reduce one composer-menu message: Lexical reports the trigger context,
 *  arrows walk the filtered suggestions clamped at both ends, and an
 *  accepted/picked suggestion applies through `applySuggestion`. */
export const reduceComposerMenu = (model: Model, message: ComposerMenuMessage): UpdateReturn =>
  M.value(message).pipe(
    M.withReturnType<UpdateReturn>(),
    M.tagsExhaustive({
      // Lexical found a trigger immediately before the caret.
      ComposerTriggerChanged: ({ trigger, query }) => [
        { ...model, composerMenu: { active: 0, query, trigger } },
        none,
        Option.none(),
      ],

      ComposerMenuClosed: () => closeComposerMenu(model),

      ComposerMenuMoved: ({ delta }) => {
        if (model.composerMenu === null) {
          return [model, none, Option.none()];
        }
        const { trigger, query, active } = model.composerMenu;
        const current = options(model, trigger, query);
        if (current.length === 0) {
          return [model, none, Option.none()];
        }
        const next = Math.min(Math.max(active + delta, 0), current.length - 1);
        return [{ ...model, composerMenu: { active: next, query, trigger } }, none, Option.none()];
      },

      ComposerSuggestionAccepted: () => {
        if (model.composerMenu === null) {
          return [model, none, Option.none()];
        }
        const { trigger, query, active } = model.composerMenu;
        const current = options(model, trigger, query);
        const suggestion = current[Math.min(Math.max(active, 0), current.length - 1)];
        if (suggestion === undefined) {
          return [model, none, Option.none()];
        }
        return applySuggestion(model, trigger, suggestion);
      },

      ComposerSuggestionPicked: ({ trigger, value }) => {
        if (model.composerMenu === null || model.composerMenu.trigger !== trigger) {
          return [model, none, Option.none()];
        }
        const suggestion = options(model, trigger, model.composerMenu.query).find(
          (candidate) => candidate.value === value,
        );
        if (suggestion === undefined) {
          return [model, none, Option.none()];
        }
        return applySuggestion(model, trigger, suggestion);
      },
    }),
  );
