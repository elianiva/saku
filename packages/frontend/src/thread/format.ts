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

import { Result } from "effect";

import type { MessageProjection } from "./projection.ts";

export const asString = (value: unknown): string => (typeof value === "string" ? value : "");

export const messageRole = (message: MessageProjection): string => asString(message.role);

/** An assistant message that failed: `stop: error` with the provider's error. */
export const messageError = (message: MessageProjection): string =>
  message.stopReason === "error" ? asString(message.errorMessage) : "";

/** The joined text content of a message (all text blocks / raw strings). */
export const messageText = (message: MessageProjection): string => {
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
export const messageThinking = (message: MessageProjection): string => {
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
  readonly args: string;
}

/** The tool calls an assistant message asks for. */
export const messageToolCalls = (message: MessageProjection): ToolCallRow[] => {
  const content = message.content;
  if (!Array.isArray(content)) return [];
  const rows: ToolCallRow[] = [];
  for (const block of content) {
    if (block.type !== "toolCall") continue;
    rows.push({
      id: asString(block.id),
      name: asString(block.name),
      args: argsPreview(block.arguments),
    });
  }
  return rows;
};

export interface ToolResultRow {
  readonly name: string;
  readonly text: string;
  readonly isError: boolean;
}

/** A toolResult message's payload. */
export const messageToolResult = (message: MessageProjection): ToolResultRow | null => {
  if (message.role !== "toolResult") return null;
  return {
    name: asString(message.toolName),
    text: messageText(message),
    isError: message.isError === true,
  };
};

/**
 * One-line JSON of an unknown value, falling back to `String(value)` when
 * it cannot be stringified (circular refs). `Result.try` at the sync
 * stringify point (house style: no try/catch).
 */
const jsonLine = (value: unknown): string => {
  const raw = Result.try(() => (typeof value === "string" ? value : JSON.stringify(value)));
  return Result.isSuccess(raw) ? raw.success : String(value);
};

/** A one-line JSON preview of tool arguments, truncated to the head. */
export const argsPreview = (value: unknown): string => {
  if (value === undefined) return "";
  const raw = jsonLine(value);
  return raw.length > 240 ? `${raw.slice(0, 240)}…` : raw;
};

/** Streamed tool output grows; render its tail. */
export const tail = (text: string, limit: number): string =>
  text.length > limit ? `…${text.slice(text.length - limit)}` : text;

/** Streamed tool partials/results: strings as-is, everything else as JSON. */
export const stringifyLive = (value: unknown): string => {
  if (value === undefined) return "";
  if (typeof value === "string") return tail(value, 1200);
  const raw = jsonLine(value);
  return raw.length > 400 ? `${raw.slice(0, 400)}…` : raw;
};

/** First line of a summary (compaction, branch), truncated. */
export const summaryLine = (summary: unknown): string => {
  const text = asString(summary);
  const first = text.split("\n", 1)[0] ?? "";
  return first.length > 160 ? `${first.slice(0, 160)}…` : first;
};
