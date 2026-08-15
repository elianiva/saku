/**
 * The thread rail's view (rail/view.ts): the registry projection plus pi's
 * sessions on this machine (CONTEXT.md: Pi sessions). A header, a transient
 * notice, and the live list — one row per thread with state, mode, and env
 * glyphs, a delete ✕, and click-to-select — and below it the pi-session
 * section: the sessions not yet adopted as threads, one row per session,
 * click-to-adopt-and-open (no import framing — opening a session is just
 * opening a session). The section exists only when there is something to
 * show: a failed or empty list renders nothing (a remote hub has no ~/.pi).
 * Row content comes entirely from `thread_changed` broadcasts and command
 * landings; the rail never computes it. (The quick-start composer lived
 * here once; it moved to the pane's welcome with the gesture — the rail is
 * the list and nothing else.)
 *
 * Branded via `defineView` so it embeds under the root through
 * `h.submodel`, with `h` typed to the rail's own Message union (the lutra
 * gallery view pattern).
 */

import { AsyncData, Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import type { PiSessionInfo, ThreadInfo } from "@saku/wire";

import { envPresentation, modeChar, statePresentation, unadoptedPiSessions } from "../presentation.ts";
import {
  ClickedThread,
  DeleteRequested,
  PiSessionClicked,
  RefreshRequested,
  type RailMessage,
} from "./message.ts";
import type { Model } from "./model.ts";

export const view = Submodel.defineView<Model, RailMessage>((model, h) =>
  h.aside(
    [h.Class("w-80 shrink-0 border-r border-line bg-surface flex flex-col min-h-0")],
    [railHeader(model, h), notice(model, h), railList(model, h)],
  ),
);

/** A transient failure notice (delete failures), null when clean. */
const notice = (model: Model, h: HtmlBuilder<RailMessage>) =>
  model.notice === null
    ? null
    : h.div(
        [h.Class("border-b border-love/40 bg-overlay px-3 py-1.5 text-[11px] text-love")],
        [model.notice],
      );

const railHeader = (model: Model, h: HtmlBuilder<RailMessage>) => {
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

const railList = (model: Model, h: HtmlBuilder<RailMessage>) =>
  AsyncData.match(model.list, {
    onIdle: () => railStatus(h, "loading…"),
    onLoading: () => railStatus(h, "loading…"),
    onRefreshing: () => railStatus(h, "loading…"),
    onStale: () => railStatus(h, "loading…"),
    onFailure: (error) => railStatus(h, `threads unavailable — ${error.message}`),
    onSuccess: (threads) =>
      h.div(
        [h.Class("flex-1 overflow-y-auto min-h-0")],
        [
          ...threads.map((thread) => threadRow(thread, model.selectedId, h)),
          piSection(model, threads, h),
        ],
      ),
  });

const railStatus = (h: HtmlBuilder<RailMessage>, text: string) =>
  h.div([h.Class("p-4 text-muted text-[12px]")], [text]);

const threadRow = (
  thread: ThreadInfo,
  selectedId: string | null,
  h: HtmlBuilder<RailMessage>,
) => {
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

const stateGlyph = (thread: ThreadInfo, h: HtmlBuilder<RailMessage>) => {
  const { glyph, tone, title } = statePresentation(thread.state);
  return h.span([h.Class(tone), h.Title(title)], [glyph]);
};

const envGlyph = (thread: ThreadInfo, h: HtmlBuilder<RailMessage>) => {
  const { glyph, tone, title } = envPresentation(thread.env);
  return h.span([h.Class(tone), h.Title(title)], [glyph]);
};

const modeGlyph = (thread: ThreadInfo, h: HtmlBuilder<RailMessage>) =>
  h.span(
    [
      h.Class("border border-line px-1 text-[10px] text-subtle uppercase"),
      h.Title(`mode: ${thread.mode}`),
    ],
    [modeChar(thread.mode)],
  );

/** The pi-session section below the threads: the sessions this machine has
 *  that aren't threads yet. Hidden unless there is something to show — a
 *  failed list (remote hub) or an empty one renders nothing. */
const piSection = (
  model: Model,
  threads: readonly ThreadInfo[],
  h: HtmlBuilder<RailMessage>,
) => {
  if (model.piSessions._tag !== "Success") return null;
  const sessions = unadoptedPiSessions(threads, model.piSessions.data);
  if (sessions.length === 0) return null;
  return h.div(
    [h.Class("border-t border-line mt-1")],
    [
      h.div(
        [
          h.Class(
            "px-3 pt-2 pb-1 text-[10px] uppercase tracking-[0.18em] text-subtle",
          ),
        ],
        [`pi sessions · ${sessions.length}`],
      ),
      ...sessions.map((session) => piSessionRow(session, model.adopting, h)),
    ],
  );
};

/** One pi session: click to adopt and open — the import is not an event the
 *  user performs, it is what opening a session means (CONTEXT.md: Pi
 *  sessions). */
const piSessionRow = (
  session: PiSessionInfo,
  adopting: string | null,
  h: HtmlBuilder<RailMessage>,
) => {
  const busy = adopting === session.path;
  const title =
    session.name ??
    (session.firstMessage === "(no messages)" ? session.id : session.firstMessage);
  return h.button(
    [
      h.Class(
        `w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12px] ${busy ? "text-muted" : "hover:bg-overlay/60"}`,
      ),
      h.OnClick(PiSessionClicked({ path: session.path })),
      h.Disabled(busy),
      h.Title(session.path),
    ],
    [
      h.span([h.Class("text-subtle shrink-0")], ["π"]),
      h.span([h.Class("flex-1 truncate min-w-0")], [busy ? "opening…" : title]),
      h.span([h.Class("text-muted shrink-0")], [`${session.messageCount} msgs`]),
    ],
  );
};
