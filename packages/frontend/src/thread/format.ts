/**
 * Formatting and extraction helpers (format.ts): the console renders pi's
 * vocabulary, so these read pi's message/entry shapes through the console's
 * schema projections (projection.ts — decoded at the boundaries, ADR 0005).
 * Every field is optional: pi renders what is present, and `asString` is the
 * defensive cast that keeps optional fields renderable.
 *
 * pi-ai's message shapes (what the projections read):
 * - user: `{ role: "user", content: string | (text|image)[] }`
 * - assistant: `{ role: "assistant", content: (text|thinking|toolCall)[] }`
 * - toolResult: `{ role: "toolResult", toolCallId, toolName, content, isError }`
 */

import { jsonLine, toolArgsView, type ToolArgsView } from "./tools.ts";

import type { EntryProjection, MessageProjection } from "./projection.ts";

export const asString = (value: unknown) => (typeof value === "string" ? value : "");

export const messageRole = (message: MessageProjection) => asString(message.role);

/** An assistant message that failed: `stop: error` with the provider's error. */
export const messageError = (message: MessageProjection) =>
  message.stopReason === "error" ? asString(message.errorMessage) : "";

/** The joined text content of a message (all text blocks / raw strings). */
export const messageText = (message: MessageProjection) => {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block.type === "text" ? asString(block.text) : ""))
      .join("")
      .trim();
  }
  return "";
};

/** The joined thinking content of a message. */
export const messageThinking = (message: MessageProjection) => {
  const content = message.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block.type === "thinking" ? asString(block.thinking) : ""))
    .join("")
    .trim();
};

export interface ToolCallRow {
  readonly id: string;
  readonly name: string;
  /** Per-tool rendering of the call's arguments (tools.ts): the preview
   *  is the collapsed summary, the lines the expanded body. */
  readonly args: ToolArgsView;
}

/** The tool calls an assistant message asks for. */
export const messageToolCalls = (message: MessageProjection) => {
  const content = message.content;
  if (!Array.isArray(content)) return [];
  const rows: ToolCallRow[] = [];
  for (const block of content) {
    if (block.type !== "toolCall") continue;
    rows.push({
      id: asString(block.id),
      name: asString(block.name),
      args: toolArgsView(asString(block.name), block.arguments),
    });
  }
  return rows;
};

export interface ToolResultRow {
  /** The tool call this result answers. */
  readonly callId: string;
  readonly name: string;
  readonly text: string;
  readonly isError: boolean;
}

/** A toolResult message's payload. */
export const messageToolResult = (message: MessageProjection) => {
  if (message.role !== "toolResult") return null;
  return {
    callId: asString(message.toolCallId),
    name: asString(message.toolName),
    text: messageText(message),
    isError: message.isError === true,
  };
};

/** The trail's tool pairing index: toolResult messages keyed by the call
 *  they answer, and the call ids that have a result. The view merges a
 *  paired call + result into one row (the result entry itself is then not
 *  rendered); an unpaired result keeps its standalone row (its call was
 *  compacted away or never landed). */
export interface TrailToolIndex {
  readonly results: ReadonlyMap<string, ToolResultRow>;
  readonly paired: ReadonlySet<string>;
}

export const trailToolIndex = (entries: readonly EntryProjection[]): TrailToolIndex => {
  const results = new Map<string, ToolResultRow>();
  const calls = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message ?? {};
    if (messageRole(message) === "toolResult") {
      const result = messageToolResult(message);
      if (result !== null && result.callId !== "") results.set(result.callId, result);
    } else if (messageRole(message) === "assistant") {
      for (const call of messageToolCalls(message)) {
        if (call.id !== "") calls.add(call.id);
      }
    }
  }
  return { results, paired: new Set([...calls].filter((id) => results.has(id))) };
};

/** Streamed tool output grows; render its tail. */
export const tail = (text: string, limit: number) =>
  text.length > limit ? `…${text.slice(text.length - limit)}` : text;

/** Streamed tool partials/results: strings as-is, everything else as JSON. */
export const stringifyLive = (value: unknown) => {
  if (value === undefined) return "";
  if (typeof value === "string") return tail(value, 1200);
  const raw = jsonLine(value);
  return raw.length > 400 ? `${raw.slice(0, 400)}…` : raw;
};

/** First line of a summary (compaction, branch), truncated. */
export const summaryLine = (summary: unknown) => {
  const text = asString(summary);
  const first = text.split("\n", 1)[0] ?? "";
  return first.length > 160 ? `${first.slice(0, 160)}…` : first;
};
