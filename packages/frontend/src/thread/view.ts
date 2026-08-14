/**
 * The thread pane's view (thread/view.ts): the selected thread's surface —
 * header (name, state, env), the entry trail, the live run (streaming
 * message + tool activity), and the composer — or, on the root route, the
 * welcome: wordmark, greeting, and the quick-start composer in a centered
 * chat-app column (CONTEXT.md: Quick start). The composer is one shared
 * box with a focus-aware placeholder (the humanlayer pattern: unfocused
 * shows the affordance, focused the task) and the failure notice sits under
 * it, next to the action that caused it. The trail renders pi's entries
 * verbatim (ADR 0004): user/assistant/toolResult messages, tool calls,
 * compactions, and the metadata entries as dim rails.
 *
 * Branded via `defineView` so it embeds under the root through
 * `h.submodel`, with `h` typed to the pane's own Message union (the lutra
 * gallery/editor view pattern).
 */

import { AsyncData, Submodel } from "foldkit";
import { Match, Option, Stream } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import type { PiSessionInfo, ThreadEnvState, ThreadState } from "@saku/wire";

import { headerState } from "../presentation.ts";
import {
  asString,
  messageError,
  messageRole,
  messageText,
  messageThinking,
  messageToolCalls,
  messageToolResult,
  summaryLine,
} from "./format.ts";
import type { LiveTool } from "./live.ts";
import {
  AbortRequested,
  ComposerBlurred,
  ComposerChanged,
  ComposerFocused,
  PiImportRequested,
  PiPickerClosed,
  PiSessionsRequested,
  SendRequested,
  type ThreadMessage,
} from "./message.ts";
import type { Model } from "./model.ts";
import type { EntryProjection, MessageProjection } from "./projection.ts";

export const view = Submodel.defineView<Model, ThreadMessage>((model, h) =>
  h.section(
    [h.Class("flex-1 flex flex-col min-w-0 min-h-0")],
    model.id === null
      ? [welcome(model, h)]
      : [threadHeader(model, h), trailArea(model, h), composerArea(model, h)],
  ),
);

// -- header -----------------------------------------------------------------

const threadHeader = (model: Model, h: HtmlBuilder<ThreadMessage>): Html => {
  const info = model.info;
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
      ...(info?.state === "working" ? [abortButton(h)] : []),
      headerStateLine(info?.state, info?.env, h),
    ],
  );
};

/** The header's `state · env` line, from the shared derivation. */
const headerStateLine = (
  state: ThreadState | undefined,
  env: ThreadEnvState | undefined,
  h: HtmlBuilder<ThreadMessage>,
): Html => {
  const { text, tone } = headerState(state, env);
  return h.span([h.Class(`${tone} text-[11px] uppercase tracking-[0.18em] shrink-0`)], [text]);
};

const abortButton = (h: HtmlBuilder<ThreadMessage>): Html =>
  h.button(
    [
      h.Class(
        "border border-love text-love px-2 py-0.5 text-[11px] uppercase tracking-[0.18em] hover:bg-love/10 shrink-0",
      ),
      h.OnClick(AbortRequested()),
    ],
    ["■ abort"],
  );

// -- the trail --------------------------------------------------------------

const trailArea = (model: Model, h: HtmlBuilder<ThreadMessage>): Html =>
  AsyncData.match(model.trail, {
    onIdle: () => trailStatus(h, "loading trail…"),
    onLoading: () => trailStatus(h, "loading trail…"),
    onRefreshing: () => trailStatus(h, "loading trail…"),
    onStale: () => trailStatus(h, "loading trail…"),
    onFailure: (error) => trailStatus(h, `trail unavailable — ${error}`),
    onSuccess: ({ entries }) =>
      h.div(
        [h.Class("flex-1 min-h-0 overflow-y-auto bg-base"), h.Attribute("id", "trail")],
        [...entries.map((entry) => renderEntry(entry, h)), liveRegion(model, h)],
      ),
  });

const trailStatus = (h: HtmlBuilder<ThreadMessage>, text: string): Html =>
  h.div(
    [h.Class("flex-1 min-h-0 flex items-center justify-center text-muted text-[12px]")],
    [text],
  );

const renderEntry = (entry: EntryProjection, h: HtmlBuilder<ThreadMessage>): Html =>
  Match.value(entry.type).pipe(
    Match.when("message", () => renderMessageEntry(entry.message ?? {}, h)),
    Match.when("compaction", () => metaRow(h, `▚ compacted — ${summaryLine(entry.summary)}`)),
    Match.when("branch_summary", () => metaRow(h, `⑂ branch — ${summaryLine(entry.summary)}`)),
    Match.when("model_change", () =>
      metaRow(h, `~ model → ${asString(entry.provider)}/${asString(entry.modelId)}`),
    ),
    Match.when("thinking_level_change", () =>
      metaRow(h, `~ thinking → ${asString(entry.thinkingLevel)}`),
    ),
    Match.when("active_tools_change", () => {
      const tools = Array.isArray(entry.activeToolNames)
        ? entry.activeToolNames.map(asString).join(", ")
        : "";
      return metaRow(h, `~ tools → ${tools}`);
    }),
    Match.orElse((type) => metaRow(h, `· ${asString(type) || "entry"}`)),
  );

const metaRow = (h: HtmlBuilder<ThreadMessage>, text: string): Html =>
  h.div([h.Class("px-4 py-1 border-b border-line text-[11px] text-subtle italic")], [text]);

const renderMessageEntry = (message: MessageProjection, h: HtmlBuilder<ThreadMessage>): Html => {
  const role = messageRole(message);
  if (role === "user") {
    return h.div(
      [h.Class("px-4 py-3 border-b border-line")],
      [
        roleLabel(h, "you", "text-pine"),
        h.pre(
          [h.Class("whitespace-pre-wrap text-[13px] leading-relaxed mt-1")],
          [messageText(message)],
        ),
      ],
    );
  }
  if (role === "toolResult") {
    const result = messageToolResult(message);
    if (result === null) return null;
    return h.div(
      [h.Class("px-4 py-2 border-b border-line bg-surface")],
      [
        h.div(
          [h.Class("flex items-center gap-2")],
          [
            h.span(
              [
                h.Class(
                  `text-[10px] uppercase tracking-[0.18em] ${result.isError ? "text-love" : "text-subtle"}`,
                ),
              ],
              [result.isError ? "tool ✗" : "tool"],
            ),
            h.span([h.Class("text-[11px] text-muted font-bold")], [result.name]),
          ],
        ),
        ...(result.text === ""
          ? []
          : [
              h.pre(
                [
                  h.Class(
                    "whitespace-pre-wrap text-[12px] text-subtle mt-1 max-h-64 overflow-y-auto",
                  ),
                ],
                [result.text],
              ),
            ]),
      ],
    );
  }
  if (role === "assistant") {
    const calls = messageToolCalls(message);
    const thinking = messageThinking(message);
    const text = messageText(message);
    const error = messageError(message);
    return h.div(
      [h.Class("px-4 py-3 border-b border-line")],
      [
        roleLabel(h, "saku", "text-iris"),
        ...(error === ""
          ? []
          : [
              h.div(
                [h.Class("mt-1 border-l-2 border-love/60 pl-2 text-[12px] text-love")],
                [`model error — ${error}`],
              ),
            ]),
        ...(thinking === ""
          ? []
          : [
              h.div(
                [h.Class("text-[12px] text-muted italic mt-1 border-l-2 border-muted/40 pl-2")],
                [thinking],
              ),
            ]),
        ...(text === ""
          ? []
          : [h.pre([h.Class("whitespace-pre-wrap text-[13px] leading-relaxed mt-1")], [text])]),
        ...(calls.length === 0
          ? []
          : [
              h.div(
                [h.Class("mt-2 flex flex-col gap-1")],
                calls.map((call) =>
                  h.div(
                    [
                      h.Class(
                        "flex items-baseline gap-2 border border-line bg-surface px-2 py-1 text-[12px]",
                      ),
                    ],
                    [
                      h.span([h.Class("text-pine shrink-0")], ["▸"]),
                      h.span([h.Class("font-bold shrink-0")], [call.name]),
                      h.span([h.Class("text-muted truncate")], [call.args]),
                    ],
                  ),
                ),
              ),
            ]),
      ],
    );
  }
  // Other roles (system, custom): render as a dim rail with the raw text.
  const text = messageText(message);
  return metaRow(h, `· ${role || "message"}${text === "" ? "" : ` — ${summaryLine(text)}`}`);
};

const roleLabel = (h: HtmlBuilder<ThreadMessage>, label: string, tone: string): Html =>
  h.div([h.Class(`text-[10px] uppercase tracking-[0.18em] ${tone}`)], [label]);

// -- the live run -----------------------------------------------------------

const liveRegion = (model: Model, h: HtmlBuilder<ThreadMessage>): Html => {
  const { live } = model;
  const hasMessage = live.message !== undefined && live.message !== "";
  const hasTools = live.tools.length > 0;
  const hasNotice = live.notice !== undefined;
  if (!hasMessage && !hasTools && !hasNotice) return null;
  return h.div(
    [h.Class("border-t-2 border-pine/40 bg-surface")],
    [
      ...(hasNotice ? [metaRow(h, live.notice ?? "")] : []),
      ...(hasMessage
        ? [
            h.div(
              [h.Class("px-4 py-3")],
              [
                roleLabel(h, "saku", "text-iris"),
                h.pre(
                  [h.Class("whitespace-pre-wrap text-[13px] leading-relaxed mt-1")],
                  [`${live.message ?? ""}▊`, h.span([h.Class("saku-cursor")], [])],
                ),
              ],
            ),
          ]
        : []),
      ...(live.thinking !== undefined && live.thinking !== ""
        ? [
            h.div(
              [h.Class("px-4 pt-2 text-[12px] text-muted italic border-l-2 border-muted/40 ml-4")],
              [live.thinking],
            ),
          ]
        : []),
      ...(hasTools
        ? [
            h.div(
              [h.Class("px-4 pb-3 flex flex-col gap-1")],
              live.tools.map((tool) => liveToolRow(tool, h)),
            ),
          ]
        : []),
    ],
  );
};

const liveToolRow = (tool: LiveTool, h: HtmlBuilder<ThreadMessage>): Html => {
  const glyph = tool.state === "running" ? "◌" : tool.state === "done" ? "✓" : "✗";
  const tone =
    tool.state === "running" ? "text-gold" : tool.state === "done" ? "text-foam" : "text-love";
  const output =
    tool.state === "running" ? (tool.partial ?? "") : (tool.result ?? tool.partial ?? "");
  return h.div(
    [h.Class("flex flex-col gap-0.5 border border-line bg-base px-2 py-1")],
    [
      h.div(
        [h.Class("flex items-baseline gap-2 text-[12px]")],
        [
          h.span([h.Class(`${tone} shrink-0`), h.Title(tool.callId)], [glyph]),
          h.span([h.Class("font-bold")], [tool.name]),
          h.span([h.Class("text-muted text-[11px]")], [tool.state]),
        ],
      ),
      ...(output === ""
        ? []
        : [
            h.pre(
              [h.Class("whitespace-pre-wrap text-[12px] text-subtle max-h-40 overflow-y-auto")],
              [output],
            ),
          ]),
    ],
  );
};

// -- the composer -----------------------------------------------------------

/** The docked composer area under a pinned thread's trail. */
const composerArea = (model: Model, h: HtmlBuilder<ThreadMessage>): Html =>
  h.div(
    [h.Class("shrink-0 border-t border-line bg-surface p-3")],
    [composerBox(model, h, "thread")],
  );

/**
 * The composer box, shared by the thread pane and the welcome: the textarea
 * (focus-aware placeholder, enter to send) plus the action button, with the
 * failure notice underneath (the humanlayer pattern — status sits next to
 * the action that caused it, not in a banner above the trail). On the
 * welcome the box is the quick-start gesture; on a thread it prompts the
 * pinned thread. The welcome's box autofocuses on mount — every arrival at
 * the root route lands the cursor in the composer (the thread box never
 * autofocuses).
 */
const composerBox = (
  model: Model,
  h: HtmlBuilder<ThreadMessage>,
  kind: "thread" | "welcome",
): Html => {
  const working = model.info?.state === "working";
  const busy = kind === "thread" ? working : model.starting;
  const placeholder =
    kind === "welcome" && model.starting
      ? "spinning up a thread…"
      : model.focused
        ? kind === "welcome"
          ? "prompt saku — enter to spin up a thread"
          : "prompt the thread · enter to send · shift+enter for a newline"
        : "enter to start typing…";
  return h.div(
    [h.Class("flex flex-col")],
    [
      h.div(
        [h.Class("flex items-stretch gap-2")],
        [
          h.textarea([
            h.Class(
              "flex-1 resize-none bg-base border border-line px-3 py-2 text-[13px] outline-none focus:border-subtle placeholder:text-muted",
            ),
            h.Rows(3),
            h.Placeholder(placeholder),
            h.Spellcheck(false),
            h.Disabled(busy),
            h.Value(model.composer),
            h.OnInput((raw) => ComposerChanged({ text: raw })),
            h.OnKeyDownPreventDefault((key, modifiers) =>
              key === "Enter" && !modifiers.shiftKey && !busy
                ? Option.some(SendRequested())
                : Option.none(),
            ),
            h.OnFocus(ComposerFocused()),
            h.OnBlur(ComposerBlurred()),
            ...(kind === "welcome"
              ? [
                  h.OnMount({
                    name: "AutofocusComposer",
                    f: (element) => {
                      (element as HTMLTextAreaElement).focus();
                      return Stream.empty;
                    },
                  }),
                ]
              : []),
          ]),
          kind === "thread" && working
            ? abortButton(h)
            : h.button(
                [
                  h.Class(
                    "shrink-0 border border-pine text-pine px-4 text-[13px] hover:bg-pine/10",
                  ),
                  h.OnClick(SendRequested()),
                  h.Disabled(busy),
                ],
                [kind === "welcome" ? "start ❯" : "send ❯"],
              ),
        ],
      ),
      model.notice === null ? null : h.div([h.Class("mt-2 text-[12px] text-love")], [model.notice]),
    ],
  );
};

// -- welcome ----------------------------------------------------------------

/** The root route's surface: wordmark, greeting, and the quick-start
 *  composer in a centered chat-app column (CONTEXT.md: Quick start). */
const welcome = (model: Model, h: HtmlBuilder<ThreadMessage>): Html =>
  h.div(
    [h.Class("flex-1 min-h-0 flex flex-col items-center justify-center gap-2 px-6")],
    [
      h.div([h.Class("text-[26px] font-bold uppercase tracking-[0.35em] text-text")], ["saku"]),
      h.div([h.Class("text-[13px] text-subtle")], ["Welcome back! What should we work on today?"]),
      h.div([h.Class("w-full max-w-xl mt-2")], [composerBox(model, h, "welcome")]),
      h.div([h.Class("w-full max-w-xl mt-1")], [piPicker(model, h)]),
    ],
  );

/** The welcome's "from pi…" affordance: pick a pi session to adopt. */
const piPicker = (model: Model, h: HtmlBuilder<ThreadMessage>): Html =>
  h.div([h.Class("flex flex-col")], [
    model.piPicker._tag === "Idle"
      ? h.button(
          [
            h.Class("text-[11px] text-subtle hover:text-pine self-start"),
            h.OnClick(PiSessionsRequested()),
          ],
          ["from pi…"],
        )
      : piPickerPanel(model, h),
  ]);

/** The open picker: pi's sessions on this machine, newest first. */
const piPickerPanel = (model: Model, h: HtmlBuilder<ThreadMessage>): Html =>
  h.div(
    [h.Class("border border-line bg-base")],
    [
      h.div(
        [h.Class("flex items-center gap-2 px-3 py-1.5 border-b border-line text-[10px] uppercase tracking-[0.18em] text-subtle")],
        [
          h.span([h.Class("flex-1")], ["pi sessions — adopt one as a thread"]),
          h.button(
            [h.Class("px-1 hover:text-love"), h.OnClick(PiPickerClosed()), h.AriaLabel("close pi picker")],
            ["✕"],
          ),
        ],
      ),
      AsyncData.match(model.piPicker, {
        onIdle: () => piPickerStatus(h, ""),
        onLoading: () => piPickerStatus(h, "reading ~/.pi…"),
        onRefreshing: () => piPickerStatus(h, "reading ~/.pi…"),
        onStale: () => piPickerStatus(h, "reading ~/.pi…"),
        onFailure: (error) => piPickerStatus(h, error.message),
        onSuccess: (sessions) =>
          sessions.length === 0
            ? piPickerStatus(h, "no pi sessions found")
            : h.div(
                [h.Class("max-h-56 overflow-y-auto")],
                sessions.map((session) => piSessionRow(session, model.importing, h)),
              ),
      }),
    ],
  );

const piPickerStatus = (h: HtmlBuilder<ThreadMessage>, text: string): Html =>
  h.div([h.Class("px-3 py-2 text-[12px] text-muted")], [text]);

const piSessionRow = (
  session: PiSessionInfo,
  importing: string | null,
  h: HtmlBuilder<ThreadMessage>,
): Html => {
  const busy = importing === session.path;
  const title = session.name ?? (session.firstMessage === "(no messages)" ? session.id : session.firstMessage);
  return h.button(
    [
      h.Class(
        `w-full flex items-center gap-2 px-3 py-1.5 border-b border-line last:border-b-0 text-left text-[12px] ${busy ? "text-muted" : "hover:bg-overlay/60"}`,
      ),
      h.OnClick(PiImportRequested({ path: session.path })),
      h.Disabled(busy),
      h.Title(session.path),
    ],
    [
      h.span([h.Class("flex-1 truncate min-w-0")], [busy ? "importing…" : title]),
      h.span([h.Class("text-muted shrink-0")], [`${session.messageCount} msgs`]),
      h.span([h.Class("text-muted truncate shrink-0 max-w-40")], [session.cwd]),
    ],
  );
};
