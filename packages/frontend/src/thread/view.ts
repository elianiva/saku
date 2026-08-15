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
import type { ThreadEnvState, ThreadState, WireModelInfo } from "@saku/wire";

import {
  contextTone,
  contextUsage,
  headerState,
  modelLabel,
  statePresentation,
} from "../presentation.ts";
import {
  asString,
  messageError,
  messageRole,
  messageText,
  messageThinking,
  messageToolCalls,
  messageToolResult,
  summaryLine,
  trailToolIndex,
  type ToolCallRow,
  type ToolResultRow,
  type TrailToolIndex,
} from "./format.ts";
import { markdownBody } from "./markdown.ts";
import { toolArgsView, type ToolArgLine, type ToolArgsView } from "./tools.ts";
import type { LiveTool } from "./live.ts";
import {
  AbortRequested,
  ComposerBlurred,
  ComposerChanged,
  ComposerFocused,
  ModelPicked,
  ModelPickerClosed,
  ModelPickerRequested,
  SendRequested,
  ThinkingToggled,
  ToolToggled,
  type ThreadMessage,
} from "./message.ts";
import type { Model } from "./model.ts";
import type { EntryProjection, MessageProjection } from "./projection.ts";
import { ChatScroller } from "./scroller.ts";

export const view = Submodel.defineView<Model, ThreadMessage>((model, h) =>
  h.section(
    [h.Class("flex-1 flex flex-col min-w-0 min-h-0")],
    model.id === null
      ? [welcome(model, h)]
      : [threadHeader(model, h), trailArea(model, h), composerArea(model, h)],
  ),
);

const threadHeader = (model: Model, h: HtmlBuilder<ThreadMessage>) => {
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
) => {
  const { text, tone } = headerState(state, env);
  return h.span([h.Class(`${tone} text-[11px] uppercase tracking-[0.18em] shrink-0`)], [text]);
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
    ["■ abort"],
  );

const trailArea = (model: Model, h: HtmlBuilder<ThreadMessage>) =>
  AsyncData.match(model.trail, {
    onIdle: () => trailStatus(h, "loading trail…"),
    onLoading: () => trailStatus(h, "loading trail…"),
    onRefreshing: () => trailStatus(h, "loading trail…"),
    onStale: () => trailStatus(h, "loading trail…"),
    onFailure: (error) => trailStatus(h, `trail unavailable — ${error}`),
    onSuccess: ({ entries }) => {
      const index = trailToolIndex(entries);
      return h.div(
        [h.Class("relative flex-1 min-h-0 flex flex-col bg-base max-w-3xl mx-auto")],
        [
          h.div(
            [
              h.Class("flex-1 min-h-0 overflow-y-auto"),
              h.Attribute("id", "trail"),
              h.OnMount(ChatScroller),
            ],
            [
              h.div(
                [h.Class("min-h-full flex flex-col gap-2")],
                [
                  ...entries.map((entry) => renderEntry(entry, h, model, index)),
                  liveRegion(model, h),
                ],
              ),
            ],
          ),
          scrollToLatestButton(h),
        ],
      );
    },
  });

const trailStatus = (h: HtmlBuilder<ThreadMessage>, text: string) =>
  h.div(
    [h.Class("flex-1 min-h-0 flex items-center justify-center text-muted text-[12px]")],
    [text],
  );

const renderEntry = (
  entry: EntryProjection,
  h: HtmlBuilder<ThreadMessage>,
  model: Model,
  index: TrailToolIndex,
) =>
  Match.value(entry.type).pipe(
    Match.when("message", () =>
      renderMessageEntry(entry.message ?? {}, h, entry.id ?? "", model, index),
    ),
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

const metaRow = (h: HtmlBuilder<ThreadMessage>, text: string) =>
  h.div([h.Class("px-4 py-1 text-[11px] text-subtle italic")], [text]);

const renderMessageEntry = (
  message: MessageProjection,
  h: HtmlBuilder<ThreadMessage>,
  entryId: string,
  model: Model,
  index: TrailToolIndex,
) => {
  const role = messageRole(message);
  if (role === "user") {
    return h.div(
      [
        h.Class("bg-surface border-l-2 border-pine/60 px-4 py-3"),
        h.Attribute("data-role", "user"),
      ],
      [
        roleLabel(h, "you", "text-pine font-bold"),
        h.pre(
          [h.Class("whitespace-pre-wrap text-[13px] leading-relaxed mt-1 text-text")],
          [messageText(message)],
        ),
      ],
    );
  }
  if (role === "toolResult") {
    const result = messageToolResult(message);
    if (result === null) return null;
    // A paired result renders inside its call's row (the view merges the
    // tool's args and output into one block); only a result whose call
    // never landed in this trail (compacted away) keeps its own row.
    if (index.paired.has(result.callId)) return null;
    const header = [
      h.span(
        [
          h.Class(
            `text-[10px] uppercase tracking-[0.18em] ${result.isError ? "text-love" : "text-subtle"}`,
          ),
        ],
        [result.isError ? "tool ✗" : "tool"],
      ),
      h.span([h.Class("text-[11px] text-muted font-bold")], [result.name]),
    ];
    // Nothing to reveal: a bare header row, not a collapsible.
    if (result.text === "") {
      return h.div(
        [h.Class("px-4 py-2 border-b border-line bg-surface")],
        [h.div([h.Class("flex items-center gap-2")], header)],
      );
    }
    return h.details(
      [
        h.Class("group px-4 py-2 border-b border-line bg-surface"),
        h.Open(model.toolsOpen.includes(entryId)),
        h.OnToggle((expanded) => ToolToggled({ id: entryId, expanded })),
      ],
      [
        h.summary(
          [
            h.Class(
              "flex items-center gap-2 cursor-pointer select-none marker:hidden [&::-webkit-details-marker]:hidden",
            ),
          ],
          [
            h.span(
              [
                h.Class(
                  "text-[10px] uppercase tracking-[0.18em] text-muted inline-block transition-transform duration-150 group-open:rotate-90",
                ),
              ],
              ["▸"],
            ),
            ...header,
          ],
        ),
        h.pre(
          [h.Class("whitespace-pre-wrap text-[12px] text-subtle mt-1 max-h-64 overflow-y-auto")],
          [result.text],
        ),
      ],
    );
  }
  if (role === "assistant") {
    const calls = messageToolCalls(message);
    const thinking = messageThinking(message);
    const text = messageText(message);
    const error = messageError(message);
    return h.div(
      [h.Class("")],
      [
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
              thinkingBlock(h, markdownBody(h, thinking), {
                open: model.thinkingOpen.includes(entryId),
                onToggle: (expanded) => ThinkingToggled({ messageId: entryId, expanded }),
              }),
            ]),
        ...(text === "" ? [] : [markdownBody(h, text)]),
        ...(calls.length === 0
          ? []
          : [
              h.div(
                [h.Class("flex flex-col gap-2")],
                calls.map((call) =>
                  toolCallRow(
                    call,
                    index.results.get(call.id),
                    model.toolsOpen.includes(call.id),
                    h,
                    (expanded) => ToolToggled({ id: call.id, expanded }),
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

/**
 * One merged tool row: the call's arguments AND its output in a single
 * collapsible block (the trail used to split them across the assistant
 * message and a separate toolResult entry). The collapsed summary shows
 * the tool name, its per-tool rendered args, and a ✓/✗ completion glyph;
 * expanding reveals the args and the output under it.
 */
const toolCallRow = (
  call: ToolCallRow,
  result: ToolResultRow | undefined,
  open: boolean,
  h: HtmlBuilder<ThreadMessage>,
  onToggle: (expanded: boolean) => ThreadMessage,
) =>
  h.details(
    [
      h.Class("group bg-surface px-2 py-1 text-[12px] font-mono"),
      h.Open(open),
      h.OnToggle(onToggle),
    ],
    [
      h.summary(
        [
          h.Class(
            "flex items-baseline gap-2 cursor-pointer select-none marker:hidden [&::-webkit-details-marker]:hidden",
          ),
        ],
        [
          h.span(
            [
              h.Class(
                "text-pine shrink-0 inline-block transition-transform duration-150 group-open:rotate-90",
              ),
            ],
            ["▸"],
          ),
          h.span([h.Class("font-bold shrink-0")], [call.name]),
          h.span([h.Class("text-muted truncate")], [call.args.preview]),
          ...(result === undefined
            ? []
            : [
                h.span(
                  [h.Class(`${result.isError ? "text-love" : "text-foam"} shrink-0 text-[11px]`)],
                  [result.isError ? "✗" : "✓"],
                ),
              ]),
        ],
      ),
      ...toolArgsLines(call.args, h),
      // The output section: only when the call has a result with content.
      ...(result === undefined || result.text === ""
        ? []
        : [
            h.div([h.Class("mt-1 border-t border-line/70 pt-1")], [
              h.div(
                [
                  h.Class(
                    `text-[10px] uppercase tracking-[0.18em] ${result.isError ? "text-love" : "text-subtle"}`,
                  ),
                ],
                [result.isError ? "error" : "output"],
              ),
              h.pre(
                [
                  h.Class(
                    "whitespace-pre-wrap text-[12px] text-subtle mt-0.5 max-h-64 overflow-y-auto",
                  ),
                ],
                [result.text],
              ),
            ]),
          ]),
    ],
  );

/** The per-tool argument rendering: labels for short fields, code blocks
 *  for paths/content/commands, and −/+ lines for edit diffs. */
const toolArgsLines = (args: ToolArgsView, h: HtmlBuilder<ThreadMessage>) =>
  args.lines.map((line: ToolArgLine) =>
    line.kind === "label"
      ? h.div([h.Class("mt-1 text-[10px] uppercase tracking-[0.18em] text-subtle")], [line.text])
      : line.kind === "code"
        ? h.pre(
            [h.Class("mt-0.5 whitespace-pre-wrap text-[12px] text-subtle max-h-40 overflow-y-auto")],
            [line.text],
          )
        : h.div(
            [
              h.Class(
                `mt-0.5 whitespace-pre-wrap text-[12px] font-mono ${line.kind === "removed" ? "text-love/80" : "text-foam/80"}`,
              ),
            ],
            [`${line.kind === "removed" ? "−" : "+"} ${line.text}`],
          ),
  );

const roleLabel = (h: HtmlBuilder<ThreadMessage>, label: string, tone: string) =>
  h.div([h.Class(`text-[10px] uppercase tracking-[0.18em] ${tone}`)], [label]);

/**
 * The thinking block: a `<details>` collapsible with a "thinking" summary
 * row. Collapsed by default — the expanded set lives in the model
 * (`thinkingOpen`), so a user's expand/collapse survives re-renders and
 * the live region's open state never leaks into completed messages. The
 * live region renders it with `open: true` (streaming is always shown)
 * and no toggle; trail entries are controlled by `ThinkingToggled`.
 */
const thinkingBlock = (
  h: HtmlBuilder<ThreadMessage>,
  body: Html,
  opts: { open: boolean; onToggle?: (open: boolean) => ThreadMessage },
) =>
  h.details(
    [
      h.Class("group bg-surface px-2 py-1"),
      h.Open(opts.open),
      ...(opts.onToggle === undefined ? [] : [h.OnToggle(opts.onToggle)]),
    ],
    [
      h.summary(
        [
          h.Class(
            "flex items-baseline gap-2 cursor-pointer select-none text-[12px] font-mono marker:hidden [&::-webkit-details-marker]:hidden",
          ),
        ],
        [
          h.span(
            [
              h.Class(
                "text-iris shrink-0 inline-block transition-transform duration-150 group-open:rotate-90",
              ),
            ],
            ["▸"],
          ),
          h.span([h.Class("font-bold text-iris shrink-0")], ["thinking"]),
          h.span([h.Class("text-muted truncate")], ["internal reasoning"]),
        ],
      ),
      h.div([h.Class("mt-1 border-t border-line/70 pt-1 text-[12px] text-subtle")], [body]),
    ],
  );

const liveRegion = (model: Model, h: HtmlBuilder<ThreadMessage>) => {
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
              [roleLabel(h, "saku", "text-iris"), markdownBody(h, live.message ?? "", true)],
            ),
          ]
        : []),
      ...(live.thinking !== undefined && live.thinking !== ""
        ? [
            h.div(
              [h.Class("px-4 pt-2 ml-4")],
              [thinkingBlock(h, markdownBody(h, live.thinking), { open: true })],
            ),
          ]
        : []),
      ...(hasTools
        ? [
            h.div(
              [h.Class("px-4 pb-3 flex flex-col gap-1")],
              live.tools.map((tool) => liveToolRow(tool, model.toolsOpen, h)),
            ),
          ]
        : []),
    ],
  );
};

const liveToolRow = (tool: LiveTool, open: readonly string[], h: HtmlBuilder<ThreadMessage>) => {
  const glyph = tool.state === "running" ? "◌" : tool.state === "done" ? "✓" : "✗";
  const tone =
    tool.state === "running" ? "text-gold" : tool.state === "done" ? "text-foam" : "text-love";
  const output =
    tool.state === "running" ? (tool.partial ?? "") : (tool.result ?? tool.partial ?? "");
  const args = toolArgsView(tool.name, tool.args);
  return h.details(
    [
      h.Class("group flex flex-col gap-0.5 border border-line bg-base px-2 py-1"),
      h.Open(open.includes(tool.callId)),
      h.OnToggle((expanded) => ToolToggled({ id: tool.callId, expanded })),
    ],
    [
      h.summary(
        [
          h.Class(
            "flex items-baseline gap-2 text-[12px] cursor-pointer select-none marker:hidden [&::-webkit-details-marker]:hidden",
          ),
        ],
        [
          h.span(
            [
              h.Class(
                "text-muted shrink-0 inline-block transition-transform duration-150 group-open:rotate-90",
              ),
            ],
            ["▸"],
          ),
          h.span([h.Class(`${tone} shrink-0`), h.Title(tool.callId)], [glyph]),
          h.span([h.Class("font-bold")], [tool.name]),
          ...(args.preview === ""
            ? []
            : [h.span([h.Class("text-muted truncate")], [args.preview])]),
          h.span([h.Class("text-muted text-[11px]")], [tool.state]),
        ],
      ),
      ...toolArgsLines(args, h),
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

/** The docked composer area under a pinned thread's trail. The prompt card
 *  gets enough width to feel like a work surface while staying aligned with
 *  the trail above it. */
const composerArea = (model: Model, h: HtmlBuilder<ThreadMessage>) =>
  h.div(
    [h.Class("shrink-0 border-t border-line bg-surface p-4")],
    [h.div([h.Class("w-full max-w-4xl mx-auto")], [composerBox(model, h, "thread")])],
  );

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
            ? "enter to start · shift+enter for newline"
            : "enter to send · shift+enter for newline",
        ],
      ),
      h.span([h.Class("flex-1 min-w-2")], []),
      ...(kind === "thread" ? [modelBadge(model, h), contextBadge(model, h)] : []),
      working ? abortButton(h) : sendButton(h, kind, busy),
    ],
  );
};

/** The compact submit action lives in the toolbar so the prompt remains one
 *  continuous surface. Its accessible label keeps the arrow-only treatment
 *  understandable to screen readers. */
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
    [h.span([h.Class("sr-only")], [kind === "welcome" ? "start ❯" : "send ❯"]), "↑"],
  );

/** The state glyph + word, from the shared derivation (presentation.ts). */
const stateBadge = (state: ThreadState, h: HtmlBuilder<ThreadMessage>) => {
  const p = statePresentation(state);
  return h.span([h.Class(`text-[11px] ${p.tone}`), h.Title(p.title)], [`${p.glyph} ${state}`]);
};

/** The context-usage badge: the trail's last assistant usage against the
 *  model's window, colored at the 60/90 thresholds (humanlayer's rule);
 *  hidden while unknown (no usage yet, no window, or post-compaction). */
const contextBadge = (model: Model, h: HtmlBuilder<ThreadMessage>) => {
  if (!AsyncData.isSuccess(model.trail)) return null;
  const usage = contextUsage(model.trail.data.entries, model.model);
  if (usage === null) return null;
  const { tokens, window, percent } = usage;
  return h.span(
    [
      h.Class(`shrink-0 border border-line px-1.5 py-1 text-[11px] ${contextTone(percent)}`),
      h.Title(
        `context — ${tokens.toLocaleString()} of ${window.toLocaleString()} tokens (${percent}%)`,
      ),
    ],
    [`ctx ${tokens.toLocaleString()}/${window.toLocaleString()} · ${percent}%`],
  );
};

/** The model badge: the current model, clickable to open the picker; dead
 *  while working (model changes are unavailable mid-run, humanlayer's rule). */
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
    [h.span([h.Class("truncate")], [label]), h.span([h.Class("text-muted")], ["✎"])],
  );
};

/** The open model picker: the thread's switchable models, catalog order. */
const modelPickerPanel = (model: Model, h: HtmlBuilder<ThreadMessage>) =>
  h.div(
    [h.Class("border border-line bg-base mt-2")],
    [
      h.div(
        [
          h.Class(
            "flex items-center gap-2 px-3 py-1.5 border-b border-line text-[10px] uppercase tracking-[0.18em] text-subtle",
          ),
        ],
        [
          h.span([h.Class("flex-1")], ["models — the thread's next model"]),
          h.button(
            [
              h.Class("px-1 hover:text-love"),
              h.OnClick(ModelPickerClosed()),
              h.AriaLabel("close model picker"),
            ],
            ["✕"],
          ),
        ],
      ),
      AsyncData.match(model.modelPicker, {
        onIdle: () => modelPickerStatus(h, ""),
        onLoading: () => modelPickerStatus(h, "reading models…"),
        onRefreshing: () => modelPickerStatus(h, "reading models…"),
        onStale: () => modelPickerStatus(h, "reading models…"),
        onFailure: (error) => modelPickerStatus(h, error.message),
        onSuccess: (models) =>
          models.length === 0
            ? modelPickerStatus(h, "no models available")
            : h.div(
                [h.Class("max-h-56 overflow-y-auto")],
                models.map((candidate) =>
                  modelPickerRow(candidate, model.model, model.modelBusy, h),
                ),
              ),
      }),
    ],
  );

const modelPickerStatus = (h: HtmlBuilder<ThreadMessage>, text: string) =>
  h.div([h.Class("px-3 py-2 text-[12px] text-muted")], [text]);

const modelPickerRow = (
  candidate: WireModelInfo,
  current: WireModelInfo | null,
  busy: boolean,
  h: HtmlBuilder<ThreadMessage>,
) => {
  const isCurrent =
    current !== null && current.provider === candidate.provider && current.id === candidate.id;
  return h.button(
    [
      h.Class(
        `w-full flex items-center gap-2 px-3 py-1.5 border-b border-line last:border-b-0 text-left text-[12px] ${busy ? "text-muted" : "hover:bg-overlay/60"}`,
      ),
      h.OnClick(ModelPicked({ provider: candidate.provider, modelId: candidate.id })),
      h.Disabled(busy),
      h.Title(
        `${candidate.provider}/${candidate.id} · ${candidate.contextWindow.toLocaleString()} ctx${candidate.reasoning ? " · reasoning" : ""}`,
      ),
    ],
    [
      h.span(
        [h.Class(`${isCurrent ? "text-pine" : "text-muted"} shrink-0`)],
        [isCurrent ? "▸" : "·"],
      ),
      h.span([h.Class("flex-1 truncate min-w-0")], [modelLabel(candidate)]),
      h.span([h.Class("text-muted shrink-0")], [`${candidate.contextWindow.toLocaleString()} ctx`]),
      ...(candidate.reasoning ? [h.span([h.Class("text-muted shrink-0")], ["reasoning"])] : []),
    ],
  );
};

/**
 * The composer box, shared by the thread pane and the welcome: a generous
 * prompt surface with its send action and real thread controls in one footer.
 * The textarea keeps the focus-aware placeholder and Enter/Shift+Enter
 * behavior; the failure notice stays under the action that caused it. On a
 * pinned thread the model picker opens below the card. The welcome's box
 * autofocuses on mount — every arrival at the root route lands the cursor in
 * the composer (the thread box never autofocuses).
 */
const composerBox = (model: Model, h: HtmlBuilder<ThreadMessage>, kind: "thread" | "welcome") => {
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
        [
          h.Class(
            "flex flex-col overflow-hidden border border-line bg-surface shadow-sm transition-colors focus-within:border-subtle",
          ),
        ],
        [
          h.div(
            [h.Class("px-4 pb-2 pt-3")],
            [
              h.textarea([
                h.Class(
                  "block min-h-36 w-full resize-y border-0 bg-transparent p-0 font-mono text-[13px] leading-relaxed text-text outline-none placeholder:text-muted focus:ring-0",
                ),
                h.Rows(5),
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
            ],
          ),
          composerToolbar(model, h, kind, busy),
        ],
      ),
      ...(kind === "thread" && model.modelPicker._tag !== "Idle"
        ? [modelPickerPanel(model, h)]
        : []),
      model.notice === null ? null : h.div([h.Class("mt-2 text-[12px] text-love")], [model.notice]),
    ],
  );
};

/** The jump-to-latest button (the shadcn MessageScrollerButton): floats at
 *  the trail's bottom edge, visible only while content sits below the
 *  viewport. The scroller wires its click and toggles the data-active
 *  attribute (scroller.ts); the base classes keep it hidden until then. */
const scrollToLatestButton = (h: HtmlBuilder<ThreadMessage>) =>
  h.button(
    [
      h.Class(
        "absolute bottom-4 left-1/2 -translate-x-1/2 z-10 flex h-8 items-center gap-1.5 border border-line bg-surface px-3 text-[12px] text-subtle shadow-md opacity-0 pointer-events-none transition-opacity duration-200 hover:text-text data-[active=true]:opacity-100 data-[active=true]:pointer-events-auto",
      ),
      h.Attribute("data-scroll-to-end", ""),
      h.AriaLabel("scroll to latest"),
    ],
    [h.span([h.Class("text-pine")], ["↓"]), "latest"],
  );

/** The root route's surface: wordmark, greeting, and the quick-start
 *  composer in a centered chat-app column (CONTEXT.md: Quick start). Pi's
 *  sessions live in the rail now — the welcome is the composer and nothing
 *  else. */
const welcome = (model: Model, h: HtmlBuilder<ThreadMessage>) =>
  h.div(
    [h.Class("flex-1 min-h-0 flex flex-col items-center justify-center gap-3 px-6")],
    [
      h.div([h.Class("text-[26px] font-bold uppercase tracking-[0.35em] text-text")], ["saku"]),
      h.div([h.Class("text-[13px] text-subtle")], ["Welcome back! What should we work on today?"]),
      h.div([h.Class("w-full max-w-4xl mt-2")], [composerBox(model, h, "welcome")]),
    ],
  );
