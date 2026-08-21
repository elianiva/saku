/**
 * The thread pane's trail view (view-trail.ts): the entry trail and the
 * live run — pi's entries rendered verbatim (ADR 0004), the streaming live
 * region, and the shadcn-style scroller with its jump-to-latest button.
 * Split from view.ts along the pane's seams (the trail is one surface;
 * the composer and the floating panels are others).
 */

import type { Html, HtmlBuilder } from "foldkit/html";
import { Match } from "effect";
import { AsyncData } from "foldkit";

import { icon } from "../icon.ts";
import type { IconName } from "../icon.ts";
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
} from "./format.ts";
import { markdownBody } from "./markdown.ts";
import { toolArgsView } from "./tools.ts";
import type { ToolArgLine, ToolArgsView } from "./tools.ts";
import type { ToolCallRow, ToolResultRow, TrailToolIndex } from "./format.ts";
import type { LiveTool } from "./live.ts";
import { ThinkingToggled, ToolToggled } from "./message.ts";
import type { ThreadMessage } from "./message.ts";
import type { Model } from "./model.ts";
import type { EntryProjection, MessageProjection } from "./projection.ts";
import { ChatScroller } from "./scroller.ts";

const trailStatus = (h: HtmlBuilder<ThreadMessage>, text: string) =>
  h.div(
    [h.Class("flex-1 min-h-0 flex items-center justify-center text-muted text-[12px]")],
    [text],
  );

const metaRow = (h: HtmlBuilder<ThreadMessage>, iconName: IconName, text: string) =>
  h.div(
    [h.Class("flex items-center gap-2 px-4 py-1 text-[11px] text-subtle italic")],
    [icon(h, iconName), text],
  );

/** One argument line: labels for short fields, code blocks for
 *  paths/content/commands, and plus/minus icons for edit diffs. */
const toolArgsLine = (line: ToolArgLine, h: HtmlBuilder<ThreadMessage>) => {
  if (line.kind === "label") {
    return h.div(
      [h.Class("mt-1 text-[10px] uppercase tracking-[0.18em] text-subtle")],
      [line.text],
    );
  }
  if (line.kind === "code") {
    return h.pre(
      [h.Class("mt-0.5 whitespace-pre-wrap text-[12px] text-subtle max-h-40 overflow-y-auto")],
      [line.text],
    );
  }
  return h.div(
    [
      h.Class(
        `mt-0.5 flex items-start gap-1 whitespace-pre-wrap text-[12px] font-mono ${line.kind === "removed" ? "text-love/80" : "text-foam/80"}`,
      ),
    ],
    [icon(h, line.kind === "removed" ? "minus" : "plus"), line.text],
  );
};

/** The per-tool argument rendering, in display order. */
const toolArgsLines = (args: ToolArgsView, h: HtmlBuilder<ThreadMessage>) =>
  args.lines.map((line) => toolArgsLine(line, h));

/**
 * One merged tool row: the call's arguments AND its output in a single
 * collapsible block (the trail used to split them across the assistant
 * message and a separate toolResult entry). The collapsed summary shows
 * the tool name, its per-tool rendered args, and a completion icon;
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
            [icon(h, "chevronRight")],
          ),
          h.span([h.Class("font-bold shrink-0")], [call.name]),
          h.span([h.Class("text-muted truncate")], [call.args.preview]),
          ...(result === undefined
            ? []
            : [
                h.span(
                  [h.Class(`${result.isError ? "text-love" : "text-foam"} shrink-0 text-[11px]`)],
                  [icon(h, result.isError ? "circleX" : "check")],
                ),
              ]),
        ],
      ),
      ...toolArgsLines(call.args, h),
      // The output section: only when the call has a result with content.
      ...(result === undefined || result.text === ""
        ? []
        : [
            h.div(
              [h.Class("mt-1 border-t border-line/70 pt-1")],
              [
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
              ],
            ),
          ]),
    ],
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
            [icon(h, "chevronRight")],
          ),
          h.span([h.Class("font-bold text-iris shrink-0")], ["thinking"]),
          h.span([h.Class("text-muted truncate")], ["internal reasoning"]),
        ],
      ),
      h.div([h.Class("mt-1 border-t border-line/70 pt-1 text-[12px] text-subtle")], [body]),
    ],
  );

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
      [h.Class("bg-surface border-l-2 border-pine/60 px-4 py-3"), h.Attribute("data-role", "user")],
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
    if (result === null) {
      return null;
    }
    // A paired result renders inside its call's row (the view merges the
    // tool's args and output into one block); only a result whose call
    // never landed in this trail (compacted away) keeps its own row.
    if (index.paired.has(result.callId)) {
      return null;
    }
    const header = [
      h.span(
        [
          h.Class(
            `flex items-center gap-1 text-[10px] uppercase tracking-[0.18em] ${result.isError ? "text-love" : "text-subtle"}`,
          ),
        ],
        [icon(h, result.isError ? "circleX" : "wrench"), "tool"],
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
        h.OnToggle((expanded) => ToolToggled({ expanded, id: entryId })),
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
                  "text-[10px] text-muted inline-block transition-transform duration-150 group-open:rotate-90",
                ),
              ],
              [icon(h, "chevronRight")],
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
                onToggle: (expanded) => ThinkingToggled({ expanded, messageId: entryId }),
                open: model.thinkingOpen.includes(entryId),
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
                    (expanded) => ToolToggled({ expanded, id: call.id }),
                  ),
                ),
              ),
            ]),
      ],
    );
  }
  // Other roles (system, custom): render as a dim rail with the raw text.
  const text = messageText(message);
  return metaRow(
    h,
    "circleDot",
    `${role || "message"}${text === "" ? "" : ` — ${summaryLine(text)}`}`,
  );
};

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
    Match.when("compaction", () =>
      metaRow(h, "layers", `compacted — ${summaryLine(entry.summary)}`),
    ),
    Match.when("branch_summary", () =>
      metaRow(h, "gitBranch", `branch — ${summaryLine(entry.summary)}`),
    ),
    Match.when("model_change", () =>
      metaRow(h, "arrowRight", `model ${asString(entry.provider)}/${asString(entry.modelId)}`),
    ),
    Match.when("thinking_level_change", () =>
      metaRow(h, "brain", `thinking ${asString(entry.thinkingLevel)}`),
    ),
    Match.when("active_tools_change", () => {
      const tools = Array.isArray(entry.activeToolNames)
        ? entry.activeToolNames.map(asString).join(", ")
        : "";
      return metaRow(h, "wrench", `tools ${tools}`);
    }),
    Match.orElse((type) => metaRow(h, "circleDot", asString(type) || "entry")),
  );

/** A live tool's icon by state. */
const toolStateIcon = (state: LiveTool["state"]): IconName => {
  if (state === "running") {
    return "loaderCircle";
  }
  if (state === "done") {
    return "check";
  }
  return "circleX";
};

/** A live tool's tone by state. */
const toolStateTone = (state: LiveTool["state"]) => {
  if (state === "running") {
    return "text-gold";
  }
  if (state === "done") {
    return "text-foam";
  }
  return "text-love";
};

const liveToolRow = (tool: LiveTool, open: readonly string[], h: HtmlBuilder<ThreadMessage>) => {
  const iconName = toolStateIcon(tool.state);
  const tone = toolStateTone(tool.state);
  const output =
    tool.state === "running" ? (tool.partial ?? "") : (tool.result ?? tool.partial ?? "");
  const args = toolArgsView(tool.name, tool.args);
  return h.details(
    [
      h.Class("group flex flex-col gap-0.5 border border-line bg-base px-2 py-1"),
      h.Open(open.includes(tool.callId)),
      h.OnToggle((expanded) => ToolToggled({ expanded, id: tool.callId })),
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
            [icon(h, "chevronRight")],
          ),
          h.span([h.Class(`${tone} shrink-0`), h.Title(tool.callId)], [icon(h, iconName)]),
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

const liveRegion = (model: Model, h: HtmlBuilder<ThreadMessage>) => {
  const { live } = model;
  const hasMessage = live.message !== undefined && live.message !== "";
  const hasTools = live.tools.length > 0;
  const hasNotice = live.notice !== undefined;
  if (!hasMessage && !hasTools && !hasNotice) {
    return null;
  }
  return h.div(
    [h.Class("border-t-2 border-pine/40 bg-surface")],
    [
      ...(hasNotice ? [metaRow(h, "circleAlert", live.notice ?? "")] : []),
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

/** The compact submit action lives in the toolbar so the prompt remains one
 *  continuous surface. Its accessible label keeps the arrow-only treatment
 *  understandable to screen readers. */

const scrollToLatestButton = (h: HtmlBuilder<ThreadMessage>) =>
  h.button(
    [
      h.Class(
        "absolute bottom-4 left-1/2 -translate-x-1/2 z-10 flex h-8 items-center gap-1.5 border border-line bg-surface px-3 text-[12px] text-subtle shadow-md opacity-0 pointer-events-none transition-opacity duration-200 hover:text-text data-[active=true]:opacity-100 data-[active=true]:pointer-events-auto",
      ),
      h.Attribute("data-scroll-to-end", ""),
      h.AriaLabel("scroll to latest"),
    ],
    [h.span([h.Class("text-pine")], [icon(h, "arrowDown")]), "latest"],
  );

export const trailArea = (model: Model, h: HtmlBuilder<ThreadMessage>) =>
  AsyncData.match(model.trail, {
    onFailure: (error) => trailStatus(h, `trail unavailable — ${error}`),
    onIdle: () => trailStatus(h, "loading trail…"),
    onLoading: () => trailStatus(h, "loading trail…"),
    onRefreshing: () => trailStatus(h, "loading trail…"),
    onStale: () => trailStatus(h, "loading trail…"),
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

/** The root route's surface: wordmark, greeting, and the quick-start
 *  composer in a centered chat-app column (CONTEXT.md: Quick start). Pi's
 *  sessions live in the rail now — the welcome is the composer and nothing
 *  else. */
