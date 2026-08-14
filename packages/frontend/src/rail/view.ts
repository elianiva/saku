/**
 * The thread rail's view (rail/view.ts): the registry projection. A
 * quick-start composer on top (one prompt = one thread, CONTEXT.md: Quick
 * start), then the live list — one row per thread with state, mode, and env
 * glyphs, a delete ✕, and click-to-select. Row content comes entirely from
 * `thread_changed` broadcasts; the rail never computes it.
 *
 * Branded via `defineView` so it embeds under the root through
 * `h.submodel`, with `h` typed to the rail's own Message union (the lutra
 * gallery view pattern).
 */

import { AsyncData, Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { Option } from "effect";
import type { ThreadInfo } from "@saku/wire";

import { envPresentation, modeChar, statePresentation } from "../presentation.ts";
import {
  ClickedThread,
  DeleteRequested,
  QuickStartRequested,
  RailInputChanged,
  RefreshRequested,
  type RailMessage,
} from "./message.ts";
import type { Model } from "./model.ts";

export const view = Submodel.defineView<Model, RailMessage>((model, h) =>
  h.aside(
    [h.Class("w-80 shrink-0 border-r border-line bg-surface flex flex-col min-h-0")],
    [railHeader(model, h), quickStartComposer(model, h), notice(model, h), railList(model, h)],
  ),
);

/** A transient failure notice (create/delete failures), null when clean. */
const notice = (model: Model, h: HtmlBuilder<RailMessage>): Html | null =>
  model.notice === null
    ? null
    : h.div(
        [h.Class("border-b border-love/40 bg-overlay px-3 py-1.5 text-[11px] text-love")],
        [model.notice],
      );

const railHeader = (model: Model, h: HtmlBuilder<RailMessage>): Html => {
  const count = model.list._tag === "Success" ? model.list.data.length : 0;
  return h.div(
    [
      h.Class(
        "flex items-center gap-2 px-4 h-9 shrink-0 border-b border-line text-[11px] uppercase tracking-[0.18em] text-subtle",
      ),
    ],
    [
      h.span([h.Class("flex-1")], [`threads · ${count}`]),
      h.button(
        [
          h.Class("border border-line px-1.5 hover:border-subtle"),
          h.OnClick(RefreshRequested()),
          h.AriaLabel("refresh thread list"),
          h.Title("refresh"),
        ],
        ["⟳"],
      ),
    ],
  );
};

const quickStartComposer = (model: Model, h: HtmlBuilder<RailMessage>): Html =>
  h.div(
    [h.Class("p-3 border-b border-line")],
    [
      h.div(
        [h.Class("flex items-center gap-1 border border-line bg-base px-2 py-1.5")],
        [
          h.span([h.Class("text-pine")], ["❯"]),
          h.input([
            h.Class(
              "flex-1 bg-transparent outline-none placeholder:text-muted text-[13px] min-w-0",
            ),
            h.Type("text"),
            h.Placeholder("quick start — a prompt spins up a thread"),
            h.Spellcheck(false),
            h.Value(model.input),
            h.OnInput((raw) => RailInputChanged({ text: raw })),
            h.OnKeyDownPreventDefault((key, modifiers) =>
              key === "Enter" && !modifiers.shiftKey
                ? Option.some(QuickStartRequested())
                : Option.none(),
            ),
          ]),
        ],
      ),
    ],
  );

const railList = (model: Model, h: HtmlBuilder<RailMessage>): Html =>
  AsyncData.match(model.list, {
    onIdle: () => railStatus(h, "loading…"),
    onLoading: () => railStatus(h, "loading…"),
    onRefreshing: () => railStatus(h, "loading…"),
    onStale: () => railStatus(h, "loading…"),
    onFailure: (error) => railStatus(h, `threads unavailable — ${error.message}`),
    onSuccess: (threads) =>
      h.div(
        [h.Class("flex-1 overflow-y-auto min-h-0")],
        threads.map((thread) => threadRow(thread, model.selectedId, h)),
      ),
  });

const railStatus = (h: HtmlBuilder<RailMessage>, text: string): Html =>
  h.div([h.Class("p-4 text-muted text-[12px]")], [text]);

const threadRow = (
  thread: ThreadInfo,
  selectedId: string | null,
  h: HtmlBuilder<RailMessage>,
): Html => {
  const selected = thread.id === selectedId;
  return h.div(
    [
      h.Class(
        `group flex items-center gap-2 px-3 py-2 border-b border-line cursor-pointer text-[13px] ${
          selected ? "bg-overlay" : "hover:bg-overlay/60"
        }`,
      ),
      h.OnClick(ClickedThread({ id: thread.id })),
    ],
    [
      stateGlyph(thread, h),
      h.span([h.Class("flex-1 truncate min-w-0")], [thread.name]),
      modeGlyph(thread, h),
      envGlyph(thread, h),
      h.button(
        [
          h.Class("opacity-0 group-hover:opacity-100 text-subtle hover:text-love px-1"),
          h.OnClick(DeleteRequested({ id: thread.id })),
          h.AriaLabel(`delete ${thread.name}`),
          h.Title("delete thread"),
        ],
        ["✕"],
      ),
    ],
  );
};

// -- glyphs -----------------------------------------------------------------

const stateGlyph = (thread: ThreadInfo, h: HtmlBuilder<RailMessage>): Html => {
  const { glyph, tone, title } = statePresentation(thread.state);
  return h.span([h.Class(tone), h.Title(title)], [glyph]);
};

const envGlyph = (thread: ThreadInfo, h: HtmlBuilder<RailMessage>): Html => {
  const { glyph, tone, title } = envPresentation(thread.env);
  return h.span([h.Class(tone), h.Title(title)], [glyph]);
};

const modeGlyph = (thread: ThreadInfo, h: HtmlBuilder<RailMessage>): Html =>
  h.span(
    [
      h.Class("border border-line px-1 text-[10px] text-subtle uppercase"),
      h.Title(`mode: ${thread.mode}`),
    ],
    [modeChar(thread.mode)],
  );
