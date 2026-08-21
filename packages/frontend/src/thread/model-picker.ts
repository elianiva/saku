/**
 * The model picker's update slice (model-picker.ts): everything behind the
 * composer's model badge — open/list/pick/set — as one pure reducer over
 * the pane's model. Split from thread/update.ts along its seam: the
 * picker's nine tags touch only `modelPicker`, `pickerActive`,
 * `pickerQuery`, `model`, `modelBusy`, and the panel exclusivity flags;
 * owning them here keeps thread/update.ts orchestrating instead of
 * dispatching, and this file is the slice's whole test surface.
 */

import { Match as M, Option } from "effect";

import { filterModels } from "../presentation.ts";
import { ListModelsCmd, SetModelCmd } from "./command.ts";
import type { ThreadMessage } from "./message.ts";
import type { Model } from "./model.ts";
import { ModelPicker } from "./model.ts";
import type { Commands, UpdateReturn } from "./update.ts";

const none: Commands = [];

/** The tags this slice owns; each maps to exactly one arm below. */
export type ModelPickerMessage = Extract<
  ThreadMessage,
  { readonly _tag: "ModelPickerRequested" | "ModelsListed" | "ModelsListFailed" | "PickerQueryChanged" | "PickerMove" | "ModelPicked" | "ModelSet" | "ModelSetFailed" | "ModelPickerClosed" }
>;

/**
 * Reduce one picker message; returns the next pane state and commands.
 * Opening is guarded (pinned, non-working, closed — the badge is disabled
 * while working, humanlayer's rule), a pick is guarded per in-flight
 * switch, and an unresolvable model keeps the picker open and says why.
 */
export const reduceModelPicker = (model: Model, message: ModelPickerMessage): UpdateReturn =>
  M.value(message).pipe(
    M.withReturnType<UpdateReturn>(),
    M.tagsExhaustive({
      // The badge was clicked: open loading and fetch the thread's models.
      // The picker and the usage panel float over the same card edge — only
      // one at a time.
      ModelPickerRequested: () =>
        model.id === null || model.info?.state === "working" || model.modelPicker._tag !== "Idle"
          ? [model, none, Option.none()]
          : [
              {
                ...model,
                composerMenu: null,
                modelPicker: ModelPicker.Loading(),
                pickerActive: 0,
                pickerQuery: "",
                usageOpen: false,
              },
              [ListModelsCmd({ id: model.id })],
              Option.none(),
            ],

      // The daemon answered: hold the models for the filtered view.
      ModelsListed: ({ models }) => [
        { ...model, modelPicker: ModelPicker.Success({ data: models }) },
        none,
        Option.none(),
      ],
      ModelsListFailed: ({ error }) => [
        { ...model, modelPicker: ModelPicker.Failure({ error }) },
        none,
        Option.none(),
      ],

      // The search input narrows the list; the highlight restarts at the top.
      PickerQueryChanged: ({ text }) => [
        { ...model, pickerActive: 0, pickerQuery: text },
        none,
        Option.none(),
      ],

      // ArrowUp/ArrowDown walks the filtered list, clamped at both ends.
      PickerMove: ({ delta }) => {
        if (model.modelPicker._tag !== "Success") {
          return [model, none, Option.none()];
        }
        const filtered = filterModels(model.modelPicker.data, model.pickerQuery);
        if (filtered.length === 0) {
          return [model, none, Option.none()];
        }
        const next = Math.min(Math.max(model.pickerActive + delta, 0), filtered.length - 1);
        return [{ ...model, pickerActive: next }, none, Option.none()];
      },

      // A row was clicked: guard per pick (no double switches).
      ModelPicked: ({ provider, modelId }) =>
        model.id === null || model.modelBusy
          ? [model, none, Option.none()]
          : [{ ...model, modelBusy: true }, [SetModelCmd({ id: model.id, modelId, provider })], Option.none()],

      // The switch landed: adopt the resolved model and close. A null
      // resolution keeps the picker open and says why.
      ModelSet: ({ model: next }) =>
        next === null
          ? [
              { ...model, modelBusy: false, notice: "model unavailable" },
              none,
              Option.none(),
            ]
          : [
              {
                ...model,
                model: next,
                modelBusy: false,
                modelPicker: ModelPicker.Idle(),
                notice: null,
              },
              none,
              Option.none(),
            ],
      ModelSetFailed: ({ message: text }) => [
        { ...model, modelBusy: false, notice: text },
        none,
        Option.none(),
      ],

      // The close button.
      ModelPickerClosed: () => [{ ...model, modelPicker: ModelPicker.Idle() }, none, Option.none()],
    }),
  );
