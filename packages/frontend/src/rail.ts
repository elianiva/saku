/**
 * The thread rail (rail.ts): the registry projection. A quick-start composer
 * on top (one prompt = one thread, CONTEXT.md: Quick start), then the live
 * list — one row per thread with state, mode, and env glyphs, a delete ✕,
 * and click-to-select. Row content comes entirely from `thread_changed`
 * broadcasts; the console never computes it.
 */

import type { Html, HtmlBuilder } from "foldkit/html";
import { Option } from "effect";
import type { ThreadInfo } from "@saku/wire";

import {
  DeleteRequested,
  QuickStartRequested,
  RailInputChanged,
  RefreshRequested,
  SelectRequested,
  type AppMessage,
} from "./message.ts";
import type { Model } from "./model.ts";

export const railPane = (model: Model, h: HtmlBuilder<AppMessage>): Html =>
  h.aside(
    [h.Class("w-80 shrink-0 border-r border-line bg-surface flex flex-col min-h-0")],
    [railHeader(model, h), quickStartComposer(model, h), railList(model, h)],
  );

const railHeader = (model: Model, h: HtmlBuilder<AppMessage>): Html => {
  const count = model.rail._tag === "ready" ? model.rail.threads.length : 0;
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

const quickStartComposer = (model: Model, h: HtmlBuilder<AppMessage>): Html =>
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
            h.Value(model.railInput),
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

const railList = (model: Model, h: HtmlBuilder<AppMessage>): Html => {
  switch (model.rail._tag) {
    case "loading":
      return h.div([h.Class("p-4 text-muted text-[12px]")], ["loading…"]);
    case "failed":
      return h.div(
        [h.Class("p-4 text-love text-[12px]")],
        [`threads unavailable — ${model.rail.error}`],
      );
    case "ready":
      return h.div(
        [h.Class("flex-1 overflow-y-auto min-h-0")],
        [...model.rail.threads.map((thread) => threadRow(thread, model.active, h))],
      );
  }
};

const threadRow = (thread: ThreadInfo, active: string | null, h: HtmlBuilder<AppMessage>): Html => {
  const selected = thread.id === active;
  return h.div(
    [
      h.Class(
        `group flex items-center gap-2 px-3 py-2 border-b border-line cursor-pointer text-[13px] ${
          selected ? "bg-overlay" : "hover:bg-overlay/60"
        }`,
      ),
      h.OnClick(SelectRequested({ id: thread.id })),
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

const stateGlyph = (thread: ThreadInfo, h: HtmlBuilder<AppMessage>): Html => {
  switch (thread.state) {
    case "idle":
      return h.span([h.Class("text-muted"), h.Title("idle")], ["○"]);
    case "working":
      return h.span([h.Class("text-gold animate-pulse"), h.Title("working")], ["●"]);
    case "interrupted":
      return h.span(
        [h.Class("text-rose"), h.Title("interrupted — recovery on next command")],
        ["◐"],
      );
  }
};

const envGlyph = (thread: ThreadInfo, h: HtmlBuilder<AppMessage>): Html => {
  switch (thread.env) {
    case "ready":
      return h.span([h.Class("text-foam"), h.Title("env ready")], ["▸"]);
    case "provisioning":
      return h.span([h.Class("text-gold animate-pulse"), h.Title("env provisioning")], ["◇"]);
    case "stopped":
      return h.span([h.Class("text-muted"), h.Title("env stopped — resumes on prompt")], ["▽"]);
    case "error":
      return h.span([h.Class("text-love"), h.Title("env error — next prompt retries")], ["✕"]);
  }
};

const modeGlyph = (thread: ThreadInfo, h: HtmlBuilder<AppMessage>): Html =>
  h.span(
    [
      h.Class("border border-line px-1 text-[10px] text-subtle uppercase"),
      h.Title(`mode: ${thread.mode}`),
    ],
    [thread.mode === "sandbox" ? "S" : thread.mode === "any" ? "A" : "L"],
  );
