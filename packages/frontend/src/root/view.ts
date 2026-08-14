/**
 * The root's view (root/view.ts): top bar (wordmark, connection), banner,
 * and the two submodel slots — the thread rail and the thread pane, always
 * mounted (the rail is persistent; the pane renders its empty state until
 * the route pins a thread). Everything is drawn with the html builder;
 * status is glyphs, not words, per the pseudo-TUI style. The root embeds
 * the rail and pane via `h.submodel`, wrapping every child message in the
 * `Got*Message` boundary (ADR 0009).
 */

import type { Document, Html, HtmlBuilder } from "foldkit/html";

import { view as railView } from "../rail/view.ts";
import { view as threadView } from "../thread/view.ts";
import {
  DismissBanner,
  GotRailMessage,
  GotThreadMessage,
  RetryRequested,
  type RootMessage,
} from "./message.ts";
import type { Model } from "./model.ts";

export const view = (model: Model, h: HtmlBuilder<RootMessage>): Document => ({
  title: "saku",
  body: h.div(
    [h.Class("h-screen flex flex-col bg-base text-text")],
    [
      topBar(model, h),
      banner(model, h),
      h.div(
        [h.Class("flex flex-1 min-h-0")],
        [
          h.submodel({
            slotId: "rail",
            model: model.rail,
            view: railView,
            toParentMessage: (message) => GotRailMessage({ message }),
          }),
          h.submodel({
            slotId: "thread",
            model: model.thread,
            view: threadView,
            toParentMessage: (message) => GotThreadMessage({ message }),
          }),
        ],
      ),
    ],
  ),
});

const topBar = (model: Model, h: HtmlBuilder<RootMessage>): Html =>
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

const connStatus = (model: Model, h: HtmlBuilder<RootMessage>): Html => {
  switch (model.conn._tag) {
    case "Connecting":
      return h.span([h.Class("text-muted")], ["◇ connecting"]);
    case "Online":
      return h.span([h.Class("text-foam")], [`● online · pid ${model.conn.pid}`]);
    case "Offline":
      // The retry subscription (root/subscriptions.ts) reconnects
      // automatically every couple of seconds, so offline always means
      // "retrying".
      return h.div(
        [h.Class("flex items-center gap-2")],
        [
          h.span([h.Class("text-love")], ["✕ offline"]),
          h.span([h.Class("text-muted")], ["· retrying"]),
          model.conn.error === undefined
            ? null
            : h.span([h.Class("text-subtle max-w-64 truncate")], [model.conn.error]),
          h.button(
            [
              h.Class("border border-line px-2 py-0.5 hover:border-subtle text-subtle"),
              h.OnClick(RetryRequested()),
            ],
            ["retry"],
          ),
        ],
      );
  }
};

const banner = (model: Model, h: HtmlBuilder<RootMessage>): Html =>
  model.banner === null
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
            [
              h.Class("shrink-0 hover:text-text"),
              h.OnClick(DismissBanner()),
              h.AriaLabel("dismiss"),
            ],
            ["✕"],
          ),
        ],
      );
