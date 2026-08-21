/**
 * The thread pane's view (thread/view.ts): the pane's composition root plus
 * its header (name, state, env), badges, composer, and welcome surface.
 * The three heavy surfaces live behind their own files along the same seams
 * as their update slices: the trail + live run in view-trail.ts, the
 * floating panels (model picker, @// menu, usage) in view-panels.ts. The
 * failure notice sits under the composer, next to the action that caused
 * it, dismissible and expiring (the notice lifecycle lives in update.ts +
 * subscriptions).
 *
 * Branded via `defineView` so it embeds under the root through
 * `h.submodel`, with `h` typed to the pane's own Message union (the lutra
 * gallery/editor view pattern).
 */

import { AsyncData, Submodel } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import type { ThreadEnvState, ThreadState } from "@saku/wire";

import { icon } from "../icon.ts";
import { contextTone, envPresentation, headerState, modelLabel, statePresentation, usageStatus } from "../presentation.ts";
import {
  AbortRequested,
  ModelPickerRequested,
  NewThreadRequested,
  NoticeDismissed,
  SendRequested,
  UsagePanelRequested,
} from "./message.ts";
import type { ThreadMessage } from "./message.ts";
import type { Model } from "./model.ts";
import { ComposerMount } from "./composer.ts";
import { composerSuggestions } from "./composer/options.ts";
import { composerMenuPanel, modelPickerPanel, usagePanel } from "./view-panels.ts";
import { trailArea } from "./view-trail.ts";

/** The header's new-thread button: leave the pinned thread for the
 *  welcome — the pane surfaces NewThreadRequested and the root pushes "/"
 *  (the quick-start composer is the new thread surface). */
const newThreadButton = (h: HtmlBuilder<ThreadMessage>) =>
  h.button(
    [
      h.Class(
        "flex h-8 shrink-0 items-center gap-1.5 border border-line px-2 text-[11px] uppercase tracking-[0.18em] text-subtle hover:border-subtle hover:text-text",
      ),
      h.OnClick(NewThreadRequested()),
      h.AriaLabel("new thread"),
      h.Title("start a new thread"),
    ],
    [icon(h, "plus"), "new"],
  );

/** The header's `state · env` line, from the shared derivation. */
const headerStateLine = (
  state: ThreadState | undefined,
  env: ThreadEnvState | undefined,
  h: HtmlBuilder<ThreadMessage>,
) => {
  const { tone } = headerState(state, env);
  return h.span(
    [h.Class(`${tone} flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] shrink-0`)],
    [
      state === undefined
        ? null
        : h.span(
            [h.Class("flex items-center gap-1"), h.Title(statePresentation(state).title)],
            [icon(h, statePresentation(state).icon), state],
          ),
      env === undefined
        ? null
        : h.span(
            [h.Class("flex items-center gap-1"), h.Title(envPresentation(env).title)],
            [icon(h, envPresentation(env).icon), `env ${env}`],
          ),
    ],
  );
};

const abortButton = (h: HtmlBuilder<ThreadMessage>) =>
  h.button(
    [
      h.Class(
        "flex h-8 shrink-0 items-center border border-love px-2 text-[11px] uppercase tracking-[0.18em] text-love hover:bg-love/10",
      ),
      h.OnClick(AbortRequested()),
      h.AriaLabel("abort thread"),
      h.Title("abort the running thread"),
    ],
    [icon(h, "square"), "abort"],
  );

const threadHeader = (model: Model, h: HtmlBuilder<ThreadMessage>) => {
  const { info } = model;
  return h.div(
    [
      h.Class(
        "flex items-center gap-3 px-4 h-11 shrink-0 border-b border-line bg-surface text-[13px]",
      ),
    ],
    [
      h.span([h.Class("font-bold truncate min-w-0")], [info?.name ?? model.id ?? ""]),
      h.span(
        [h.Class("text-subtle text-[11px] uppercase tracking-[0.18em] shrink-0")],
        [info?.mode ?? "local"],
      ),
      h.span([h.Class("flex-1")], []),
      newThreadButton(h),
      ...(info?.state === "working" ? [abortButton(h)] : []),
      headerStateLine(info?.state, info?.env, h),
    ],
  );
};

const sendButton = (h: HtmlBuilder<ThreadMessage>, kind: "thread" | "welcome", busy: boolean) =>
  h.button(
    [
      h.Class(
        `flex h-8 w-9 shrink-0 items-center justify-center border border-pine text-[16px] text-pine transition-colors ${busy ? "cursor-not-allowed opacity-40" : "hover:bg-pine/10"}`,
      ),
      h.OnClick(SendRequested()),
      h.Disabled(busy),
      h.AriaLabel(kind === "welcome" ? "start thread" : "send prompt"),
      h.Title(kind === "welcome" ? "start thread" : "send prompt"),
    ],
    [h.span([h.Class("sr-only")], [kind === "welcome" ? "start" : "send"]), icon(h, "arrowUp")],
  );

/** The state icon + word, from the shared derivation (presentation.ts). */
const stateBadge = (state: ThreadState, h: HtmlBuilder<ThreadMessage>) => {
  const p = statePresentation(state);
  return h.span(
    [h.Class(`flex items-center gap-1 text-[11px] ${p.tone}`), h.Title(p.title)],
    [icon(h, p.icon), state],
  );
};

/** The context-usage badge: the trail's last assistant usage against the
 *  model's window, colored at the 60/90 thresholds (humanlayer's rule);
 *  hidden while unknown (no usage yet, no window, or post-compaction). The
 *  badge toggles the floating usage panel — the last response's full
 *  breakdown (tokens in/out, cached read, hit rate, model, thinking
 *  level). */
const contextBadge = (model: Model, h: HtmlBuilder<ThreadMessage>) => {
  if (!AsyncData.isSuccess(model.trail)) {
    return null;
  }
  const status = usageStatus(model.trail.data.entries, model.model);
  if (status === null) {
    return null;
  }
  const { tokens, window, percent } = status.context;
  const open = model.usageOpen;
  return h.button(
    [
      h.Class(
        `flex shrink-0 items-center gap-1 border px-1.5 py-1 text-[11px] ${contextTone(percent)} ${open ? "border-subtle bg-overlay/40" : "border-line hover:border-subtle"}`,
      ),
      h.OnClick(UsagePanelRequested()),
      h.AriaLabel("usage details"),
      h.Attribute("aria-expanded", open ? "true" : "false"),
      h.Title(
        `context — ${tokens.toLocaleString()} of ${window.toLocaleString()} tokens (${percent}%) — click for the full usage breakdown`,
      ),
    ],
    [`ctx ${tokens.toLocaleString()}/${window.toLocaleString()} · ${percent}%`],
  );
};

/** One label/value row of the usage panel: the uppercase dim label on the
 *  left, the monospaced value right-aligned. */
const modelBadge = (model: Model, h: HtmlBuilder<ThreadMessage>) => {
  const working = model.info?.state === "working";
  const label = model.model === null ? "—" : modelLabel(model.model);
  return h.button(
    [
      h.Class(
        `flex max-w-full items-center gap-1 border border-line px-1.5 py-1 text-[11px] ${working ? "cursor-not-allowed text-muted" : "text-subtle hover:border-subtle hover:text-text"}`,
      ),
      h.OnClick(ModelPickerRequested()),
      h.Disabled(working),
      h.Title(working ? "model changes unavailable while working" : "change the thread's model"),
      h.AriaLabel("change model"),
    ],
    [h.span([h.Class("truncate")], [label]), icon(h, "pencil")],
  );
};

/** The composer's integrated footer: state and keyboard guidance on the left,
 *  then the real thread controls and the send/abort action on the right. The
 *  welcome uses the same layout without thread-only model metadata. */
const composerToolbar = (
  model: Model,
  h: HtmlBuilder<ThreadMessage>,
  kind: "thread" | "welcome",
  busy: boolean,
) => {
  const working = kind === "thread" && model.info !== null && model.info.state === "working";
  return h.div(
    [h.Class("flex flex-wrap items-center gap-1.5 border-t border-line bg-overlay/20 px-2 py-2")],
    [
      ...(kind === "thread" && model.info !== null
        ? [stateBadge(model.info.state, h)]
        : [
            h.span(
              [h.Class("text-[10px] uppercase tracking-[0.16em] text-subtle")],
              ["quick start"],
            ),
          ]),
      h.span(
        [h.Class("hidden sm:inline text-[10px] text-muted")],
        [
          kind === "welcome"
            ? "enter to start · shift+enter newline · @ files · / commands"
            : "enter to send · shift+enter newline · @ files · / commands",
        ],
      ),
      h.span([h.Class("flex-1 min-w-2")], []),
      ...(kind === "thread" ? [modelBadge(model, h), contextBadge(model, h)] : []),
      working ? abortButton(h) : sendButton(h, kind, busy),
    ],
  );
};

const composerEditor = (
  model: Model,
  h: HtmlBuilder<ThreadMessage>,
  kind: "thread" | "welcome",
  busy: boolean,
  placeholder: string,
) => {
  const menu = model.composerMenu;
  const options =
    menu === null ? [] : composerSuggestions(menu.trigger, menu.query, model.id !== null);
  const active = options.length === 0 ? -1 : Math.min(menu?.active ?? 0, options.length - 1);
  return h.div(
    [h.Class("relative")],
    [
      h.div(
        [
          h.Class(
            `saku-composer-editor block min-h-[72px] max-h-64 overflow-y-auto whitespace-pre-wrap break-words bg-transparent px-4 pb-2 pt-3 font-mono text-[13px] leading-relaxed text-text outline-none ${busy ? "cursor-not-allowed opacity-50" : ""}`,
          ),
          h.Contenteditable(String(!busy)),
          h.AriaLabel(kind === "welcome" ? "start a thread" : "prompt the thread"),
          h.Attribute("aria-placeholder", placeholder),
          h.Spellcheck(false),
          h.Autocorrect("off"),
          h.Autocapitalize("off"),
          ...(menu !== null && active >= 0
            ? [
                h.Attribute("aria-controls", "composer-suggestions"),
                h.Attribute("aria-activedescendant", `composer-option-${active}`),
              ]
            : []),
          h.OnMount(
            ComposerMount({
              autofocus: kind === "welcome",
              editable: !busy,
              initialText: model.composer,
              kind,
              placeholder,
            }),
          ),
        ],
        [],
      ),
      model.composer === ""
        ? h.div(
            [
              h.Class(
                "pointer-events-none absolute left-4 top-3 font-mono text-[13px] leading-relaxed text-muted",
              ),
              h.AriaHidden(true),
            ],
            [placeholder],
          )
        : null,
    ],
  );
};

/** The composer's placeholder: the spin-up notice on the welcome while a
 *  thread is starting, else the focus-aware affordance (humanlayer). */
const composerPlaceholder = (model: Model, kind: "thread" | "welcome") => {
  if (kind === "welcome" && model.starting) {
    return "spinning up a thread…";
  }
  if (model.focused) {
    return kind === "welcome"
      ? "prompt saku — enter to spin up a thread"
      : "prompt the thread · enter to send · shift+enter for a newline";
  }
  return "enter to start typing…";
};

/**
 * The composer box, shared by the thread pane and the welcome: a generous
 * prompt surface with its send action and real thread controls in one footer.
 * Lexical owns editing and selection; the failure notice stays under the
 * action that caused it. On a pinned thread the model picker and the usage
 * panel float above the card (absolute, overlaying the trail — the card is the
 * positioning context). The welcome's box autofocuses on mount — every
 * arrival at the root route lands the cursor in the composer.
 */
const composerBox = (model: Model, h: HtmlBuilder<ThreadMessage>, kind: "thread" | "welcome") => {
  const working = model.info?.state === "working";
  const busy = kind === "thread" ? working : model.starting;
  const placeholder = composerPlaceholder(model, kind);
  return h.div(
    [h.Class("relative flex flex-col")],
    [
      h.div(
        [
          h.Class(
            "flex flex-col overflow-hidden border border-line bg-surface transition-colors focus-within:border-subtle",
          ),
        ],
        [composerEditor(model, h, kind, busy, placeholder), composerToolbar(model, h, kind, busy)],
      ),
      // The floating panels hang off the card's top edge, overlaying the
      // trail above the composer (the card is the positioning context).
      ...(model.composerMenu === null ? [] : [composerMenuPanel(model, h)]),
      ...(kind === "thread" && model.modelPicker._tag !== "Idle"
        ? [modelPickerPanel(model, h)]
        : []),
      ...(kind === "thread" && model.usageOpen ? [usagePanel(model, h)] : []),
      // The failure notice: dismissible (the × and the 8s expiry tick both
      // land on NoticeDismissed) — a stale "thread is busy" from hours ago
      // must not survive thread switches, let alone train the user to
      // ignore the error channel.
      model.notice === null
        ? null
        : h.div([h.Class("mt-2 flex items-center gap-2 text-[12px] text-love")], [
            h.span([h.Class("min-w-0 flex-1")], [model.notice]),
            h.button(
              [
                h.Class("shrink-0 px-1 opacity-60 hover:opacity-100"),
                h.OnClick(NoticeDismissed()),
                h.AriaLabel("dismiss notice"),
                h.Title("dismiss notice"),
              ],
              [icon(h, "x")],
            ),
          ]),
    ],
  );
};

/** The docked composer area under a pinned thread's trail. The prompt card
 *  gets enough width to feel like a work surface while staying aligned with
 *  the trail above it. */
const composerArea = (model: Model, h: HtmlBuilder<ThreadMessage>) =>
  h.div(
    [h.Class("shrink-0 p-4")],
    [h.div([h.Class("w-full max-w-4xl mx-auto")], [composerBox(model, h, "thread")])],
  );

/** The jump-to-latest button (the shadcn MessageScrollerButton): floats at
 *  the trail's bottom edge, visible only while content sits below the
 *  viewport. The scroller wires its click and toggles the data-active
 *  attribute (scroller.ts); the base classes keep it hidden until then. */
const welcome = (model: Model, h: HtmlBuilder<ThreadMessage>) =>
  h.div(
    [h.Class("flex-1 min-h-0 flex flex-col items-center justify-center gap-3 px-6")],
    [
      h.div([h.Class("text-[26px] font-bold uppercase tracking-[0.35em] text-text")], ["saku"]),
      h.div([h.Class("text-[13px] text-subtle")], ["Welcome back! What should we work on today?"]),
      h.div([h.Class("w-full max-w-4xl mt-2")], [composerBox(model, h, "welcome")]),
    ],
  );
export const view = Submodel.defineView<Model, ThreadMessage>((model, h) =>
  h.section(
    [h.Class("flex-1 flex flex-col min-w-0 min-h-0")],
    model.id === null
      ? [welcome(model, h)]
      : [threadHeader(model, h), trailArea(model, h), composerArea(model, h)],
  ),
);
