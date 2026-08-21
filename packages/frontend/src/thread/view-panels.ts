import { Option, Stream } from "effect";
import { AsyncData } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";

import { icon } from "../icon.ts";
import { contextTone, filterModels, modelLabel, usageStatus } from "../presentation.ts";
import { ComposerSuggestionPicked } from "./message.ts";
import { ModelPicked, ModelPickerClosed, PickerMove, PickerQueryChanged, UsagePanelClosed } from "./message.ts";
import type { ThreadMessage } from "./message.ts";
import type { Model } from "./model.ts";
import type { WireModelInfo } from "@saku/wire";
import { composerSuggestions } from "./composer/options.ts";

const usageRow = (
  h: HtmlBuilder<ThreadMessage>,
  label: string,
  value: string,
  tone = "text-text",
) =>
  h.div(
    [h.Class("flex items-baseline justify-between gap-4")],
    [
      h.span([h.Class("shrink-0 text-[10px] uppercase tracking-[0.18em] text-muted")], [label]),
      h.span([h.Class(`truncate text-[12px] font-mono ${tone}`)], [value]),
    ],
  );

/** The floating usage panel: the last assistant response's full breakdown —
 *  context, tokens in/out, cached read, cache hit rate, the model that
 *  produced it, and the thinking level in effect then (all from pi's
 *  trail, derived in presentation.ts). Anchored to the composer card's
 *  right edge and floating above it, like the model picker; the close
 *  button is autofocused on open, and Escape closes and returns focus to
 *  the badge. */
export const usagePanel = (model: Model, h: HtmlBuilder<ThreadMessage>) => {
  if (!AsyncData.isSuccess(model.trail)) {
    return null;
  }
  const status = usageStatus(model.trail.data.entries, model.model);
  if (status === null) {
    return null;
  }
  const { tokens, window, percent } = status.context;
  return h.div(
    [
      h.Class("absolute bottom-full right-0 z-10 mb-2 w-72 border border-line bg-base shadow-lg"),
      h.OnKeyDownFocus((key) =>
        key === "Escape"
          ? Option.some({
              focusSelector: '[aria-label="usage details"]',
              message: UsagePanelClosed(),
            })
          : Option.none(),
      ),
    ],
    [
      h.div(
        [h.Class("flex items-center justify-between border-b border-line px-3 py-1.5")],
        [
          h.span(
            [h.Class("text-[10px] uppercase tracking-[0.18em] text-subtle")],
            ["usage — last response"],
          ),
          h.button(
            [
              h.Class("shrink-0 px-1 text-subtle hover:text-love"),
              h.OnClick(UsagePanelClosed()),
              h.AriaLabel("close usage panel"),
              h.Autofocus(true),
            ],
            [icon(h, "x")],
          ),
        ],
      ),
      h.div(
        [h.Class("flex flex-col gap-1.5 px-3 py-2")],
        [
          usageRow(
            h,
            "ctx",
            `${tokens.toLocaleString()}/${window.toLocaleString()} · ${percent}%`,
            contextTone(percent),
          ),
          usageRow(h, "in", status.input.toLocaleString()),
          usageRow(h, "out", status.output.toLocaleString()),
          usageRow(h, "cached", status.cacheRead.toLocaleString()),
          usageRow(
            h,
            "hit rate",
            status.cacheHitRate === null ? "—" : `${Math.round(status.cacheHitRate * 100)}%`,
          ),
          ...(status.model === null ? [] : [usageRow(h, "model", modelLabel(status.model))]),
          usageRow(h, "thinking", status.thinkingLevel ?? "—"),
        ],
      ),
    ],
  );
};

/** The model badge: the current model, clickable to open the picker; dead
 *  while working (model changes are unavailable mid-run, humanlayer's rule). */

const pickerMove = (
  key: string,
  activeModel: WireModelInfo | undefined,
  busy: boolean,
): Option.Option<ThreadMessage> => {
  if (key === "ArrowDown") {
    return Option.some(PickerMove({ delta: 1 }));
  }
  if (key === "ArrowUp") {
    return Option.some(PickerMove({ delta: -1 }));
  }
  if (key === "Enter" && activeModel !== undefined && !busy) {
    return Option.some(ModelPicked({ modelId: activeModel.id, provider: activeModel.provider }));
  }
  return Option.none();
};

const modelPickerStatus = (h: HtmlBuilder<ThreadMessage>, text: string) =>
  h.div([h.Class("px-3 py-2 text-[12px] text-muted")], [text]);

const modelPickerRow = (
  candidate: WireModelInfo,
  current: WireModelInfo | null,
  busy: boolean,
  active: boolean,
  index: number,
  h: HtmlBuilder<ThreadMessage>,
) => {
  const isCurrent =
    current !== null && current.provider === candidate.provider && current.id === candidate.id;
  return h.div(
    [
      h.Attribute("id", `model-option-${index}`),
      h.Class(
        `flex w-full cursor-pointer items-center gap-2 border-b border-line px-3 py-1.5 text-left text-[12px] last:border-b-0 ${active ? "bg-overlay/60" : ""} ${busy ? "text-muted" : "hover:bg-overlay/60"}`,
      ),
      h.Role("option"),
      h.AriaSelected(isCurrent),
      h.Attribute("aria-disabled", busy ? "true" : "false"),
      h.OnClick(ModelPicked({ modelId: candidate.id, provider: candidate.provider })),
      h.Title(
        `${candidate.provider}/${candidate.id} · ${candidate.contextWindow.toLocaleString()} ctx${candidate.reasoning ? " · reasoning" : ""}`,
      ),
    ],
    [
      h.span(
        [h.Class(`${isCurrent ? "text-pine" : "text-muted"} w-[1em] shrink-0`)],
        isCurrent ? [icon(h, "check")] : [],
      ),
      h.span([h.Class("flex-1 truncate min-w-0")], [modelLabel(candidate)]),
      h.span([h.Class("text-muted shrink-0")], [`${candidate.contextWindow.toLocaleString()} ctx`]),
      ...(candidate.reasoning ? [h.span([h.Class("text-muted shrink-0")], ["reasoning"])] : []),
    ],
  );
};

/** The open model picker: a searchable combobox floating over the trail
 *  above the composer card (the WAI-ARIA pattern — the input is the
 *  combobox control, the list its listbox, the highlighted option tracked
 *  in the model and announced via aria-activedescendant). Typing filters,
 *  the arrows move the highlight, Enter picks it, and Escape closes,
 *  returning focus to the model badge. */
export const modelPickerPanel = (model: Model, h: HtmlBuilder<ThreadMessage>) => {
  const models = AsyncData.isSuccess(model.modelPicker) ? model.modelPicker.data : [];
  const filtered = filterModels(models, model.pickerQuery);
  const active = filtered.length === 0 ? -1 : Math.min(model.pickerActive, filtered.length - 1);
  const activeModel = filtered[active];
  const busy = model.modelBusy;
  return h.div(
    [h.Class("absolute bottom-full left-0 right-0 z-10 mb-2 border border-line bg-base shadow-lg")],
    [
      h.div(
        [h.Class("flex items-center gap-2 border-b border-line px-3 py-1.5")],
        [
          h.input([
            h.Class(
              "flex-1 min-w-0 border-0 bg-transparent p-0 text-[13px] text-text outline-none placeholder:text-muted",
            ),
            h.Role("combobox"),
            h.Attribute("aria-expanded", "true"),
            h.Attribute("aria-controls", "model-list"),
            h.Attribute("aria-autocomplete", "list"),
            ...(active >= 0
              ? [h.Attribute("aria-activedescendant", `model-option-${active}`)]
              : []),
            h.AriaLabel("models — the thread's next model"),
            h.Placeholder("search models…"),
            h.Value(model.pickerQuery),
            h.OnInput((text) => PickerQueryChanged({ text })),
            h.OnKeyDownPreventDefault((key) => pickerMove(key, activeModel, busy)),
            // Escape closes the picker and returns focus to the badge (the
            // badge stays mounted while the panel is open, so the selector
            // always resolves).
            h.OnKeyDownFocus((key) =>
              key === "Escape"
                ? Option.some({
                    focusSelector: '[aria-label="change model"]',
                    message: ModelPickerClosed(),
                  })
                : Option.none(),
            ),
            h.OnMount({
              f: (element) => {
                // The picker's combobox input is the mount target (view.ts
                // mounts it on the search input), so the element is an input.
                if (element instanceof HTMLInputElement) {
                  element.focus();
                }
                return Stream.empty;
              },
              name: "FocusModelSearch",
            }),
          ]),
          h.button(
            [
              h.Class("shrink-0 px-1 text-subtle hover:text-love"),
              h.OnClick(ModelPickerClosed()),
              h.AriaLabel("close model picker"),
            ],
            [icon(h, "x")],
          ),
        ],
      ),
      AsyncData.match(model.modelPicker, {
        onFailure: (error) => modelPickerStatus(h, error.message),
        onIdle: () => modelPickerStatus(h, ""),
        onLoading: () => modelPickerStatus(h, "reading models…"),
        onRefreshing: () => modelPickerStatus(h, "reading models…"),
        onStale: () => modelPickerStatus(h, "reading models…"),
        onSuccess: () => {
          if (models.length === 0) {
            return modelPickerStatus(h, "no models available");
          }
          if (filtered.length === 0) {
            return modelPickerStatus(h, `no match for “${model.pickerQuery}”`);
          }
          return h.div(
            [
              h.Class("max-h-56 overflow-y-auto"),
              h.Role("listbox"),
              h.Attribute("id", "model-list"),
              h.AriaLabel("models"),
            ],
            filtered.map((candidate, index) =>
              modelPickerRow(candidate, model.model, busy, index === active, index, h),
            ),
          );
        },
      }),
    ],
  );
};

/** The Foldkit-owned trigger palette. Lexical reports the active @ or /
 * context through the ComposerMount; this panel is ordinary Foldkit view
 * state, so keyboard navigation and pointer selection are replayable in
 * DevTools and tests. */
export const composerMenuPanel = (model: Model, h: HtmlBuilder<ThreadMessage>) => {
  const menu = model.composerMenu;
  if (menu === null) {
    return null;
  }
  const options = composerSuggestions(menu.trigger, menu.query, model.id !== null);
  const active = options.length === 0 ? -1 : Math.min(menu.active, options.length - 1);
  return h.div(
    [
      h.Class("absolute bottom-full left-0 right-0 z-20 mb-2 border border-line bg-base shadow-lg"),
      h.Role("listbox"),
      h.Attribute("id", "composer-suggestions"),
      h.AriaLabel(menu.trigger === "file" ? "file mentions" : "slash commands"),
    ],
    [
      h.div(
        [h.Class("flex items-center justify-between border-b border-line px-3 py-1.5")],
        [
          h.span(
            [h.Class("text-[10px] uppercase tracking-[0.18em] text-subtle")],
            [menu.trigger === "file" ? "mention file" : "slash command"],
          ),
          h.span([h.Class("text-[10px] text-muted")], ["↑↓ navigate · enter select"]),
        ],
      ),
      options.length === 0
        ? h.div(
            [h.Class("px-3 py-2 text-[12px] text-muted")],
            [
              menu.trigger === "file"
                ? "type a path after @ to mention a file"
                : "no matching slash commands",
            ],
          )
        : h.div(
            [h.Class("max-h-56 overflow-y-auto")],
            options.map((suggestion, index) =>
              h.button(
                [
                  h.Attribute("type", "button"),
                  h.Attribute("id", `composer-option-${index}`),
                  h.Role("option"),
                  h.AriaSelected(index === active),
                  h.Class(
                    `flex w-full items-center gap-2 border-b border-line px-3 py-1.5 text-left text-[12px] last:border-b-0 ${index === active ? "bg-overlay/70" : "hover:bg-overlay/50"}`,
                  ),
                  h.OnMouseDown(
                    ComposerSuggestionPicked({ trigger: menu.trigger, value: suggestion.value }),
                  ),
                ],
                [
                  h.span([h.Class("w-[1em] shrink-0 text-pine")], [icon(h, suggestion.icon)]),
                  h.span([h.Class("font-mono text-text")], [suggestion.label]),
                  h.span([h.Class("min-w-0 truncate text-muted")], [suggestion.detail]),
                ],
              ),
            ),
          ),
    ],
  );
};

/** The Lexical root is intentionally childless from Foldkit's point of view:
 * Lexical owns that DOM subtree after ComposerMount attaches. The placeholder
 * is a Foldkit sibling, not text inserted into the editor state. */
