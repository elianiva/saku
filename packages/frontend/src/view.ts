/**
 * The console shell (view.ts): top bar (wordmark, connection), banner, and
 * the two panes — the thread rail and the thread pane. The rail owns the
 * registry projection; the thread pane owns the trail, the live run, and the
 * composer. Everything is drawn with the html builder; status is glyphs, not
 * words, per the pseudo-TUI style.
 */

import type { Document, Html, HtmlBuilder } from "foldkit/html";

import { DismissBanner, RetryRequested, type AppMessage } from "./message.ts";
import type { Model } from "./model.ts";
import { railPane } from "./rail.ts";
import { threadPane } from "./thread-pane.ts";

export const view = (model: Model, h: HtmlBuilder<AppMessage>): Document => ({
  title: "saku",
  body: h.div([h.Class("h-screen flex flex-col bg-base text-text")], [
    topBar(model, h),
    banner(model, h),
    h.div([h.Class("flex flex-1 min-h-0")], [railPane(model, h), threadPane(model, h)]),
  ]),
});

const topBar = (model: Model, h: HtmlBuilder<AppMessage>): Html =>
  h.div(
    [
      h.Class(
        "flex items-center gap-3 px-4 h-11 shrink-0 border-b border-line bg-surface uppercase text-[11px] tracking-[0.18em]",
      ),
    ],
    [
      h.span([h.Class("text-text font-bold tracking-[0.3em]")], ["saku"]),
      h.span([h.Class("text-subtle normal-case tracking-normal")], ["the software factory"]),
      h.span([h.Class("flex-1")], []),
      connStatus(model, h),
    ],
  );

const connStatus = (model: Model, h: HtmlBuilder<AppMessage>): Html => {
  switch (model.conn._tag) {
    case "connecting":
      return h.span([h.Class("text-muted")], ["◇ connecting"]);
    case "online":
      return h.span([h.Class("text-foam")], [`● online · pid ${model.conn.pid}`]);
    case "offline":
      return h.div([h.Class("flex items-center gap-2")], [
        h.span([h.Class("text-love")], ["✕ offline"]),
        h.button(
          [
            h.Class("border border-line px-2 py-0.5 hover:border-subtle text-subtle"),
            h.OnClick(RetryRequested()),
          ],
          ["retry"],
        ),
      ]);
  }
};

const banner = (model: Model, h: HtmlBuilder<AppMessage>): Html =>
  model.banner === undefined
    ? null
    : h.div(
        [
          h.Class(
            "flex items-center gap-3 px-4 py-1.5 border-b border-love/40 bg-overlay text-love text-[12px]",
          ),
        ],
        [
          h.span([h.Class("flex-1 truncate")], [model.banner]),
          h.button(
            [h.Class("shrink-0 hover:text-text"), h.OnClick(DismissBanner()), h.AriaLabel("dismiss")],
            ["✕"],
          ),
        ],
      );
