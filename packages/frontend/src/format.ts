/**
 * Formatting and extraction helpers (format.ts): the console renders pi's
 * vocabulary, so these narrow pi's message/entry shapes from the wire's
 * opaque `unknown` payloads (ADR 0004: entries cross verbatim; the wire
 * doesn't decode them).
 *
 * pi-ai's message shapes (what these helpers read):
 * - user: `{ role: "user", content: string | (text|image)[] }`
 * - assistant: `{ role: "assistant", content: (text|thinking|toolCall)[] }`
 * - toolResult: `{ role: "toolResult", toolCallId, toolName, content, isError }`
 */

// -- narrowing --------------------------------------------------------------

interface Block {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly thinking?: unknown;
  readonly id?: unknown;
  readonly name?: unknown;
  readonly arguments?: unknown;
}

interface MessageLike {
  readonly role?: unknown;
  readonly content?: unknown;
  readonly toolCallId?: unknown;
  readonly toolName?: unknown;
  readonly isError?: unknown;
  readonly stopReason?: unknown;
  readonly errorMessage?: unknown;
}

interface EntryLike {
  readonly id?: unknown;
  readonly seq?: unknown;
  readonly type?: unknown;
  readonly message?: unknown;
  readonly provider?: unknown;
  readonly modelId?: unknown;
  readonly thinkingLevel?: unknown;
  readonly activeToolNames?: unknown;
  readonly summary?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const asString = (value: unknown): string => (typeof value === "string" ? value : "");

export const entryOf = (value: unknown): EntryLike => (isRecord(value) ? value : {});

export const messageOf = (value: unknown): MessageLike =>
  isRecord(value) ? (value as unknown as MessageLike) : {};

export const messageRole = (message: MessageLike): string => asString(message.role);

/** An assistant message that failed: `stop: error` with the provider's error. */
export const messageError = (message: MessageLike): string =>
  message.stopReason === "error" ? asString(message.errorMessage) : "";

// -- text -------------------------------------------------------------------

const blockText = (block: Block): string => {
  if (block.type === "text") return asString(block.text);
  return "";
};

/** The joined text content of a message (all text blocks / raw strings). */
export const messageText = (message: MessageLike): string => {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (isRecord(block) ? blockText(block as unknown as Block) : ""))
      .join("")
      .trim();
  }
  return "";
};

/** The joined thinking content of a message. */export const messageThinking = (message: MessageLike): string => {
  const content = message.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      isRecord(block) && block.type === "thinking" ? asString(block.thinking) : "",
    )
    .join("")
    .trim();
};

export interface ToolCallRow {
  readonly id: string;
  readonly name: string;
  readonly args: string;
}

/** The tool calls an assistant message asks for. */
export const messageToolCalls = (message: MessageLike): ToolCallRow[] => {
  const content = message.content;
  if (!Array.isArray(content)) return [];
  const rows: ToolCallRow[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "toolCall") continue;
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
export const messageToolResult = (message: MessageLike): ToolResultRow | null => {
  if (message.role !== "toolResult") return null;
  return {
    name: asString(message.toolName),
    text: messageText(message),
    isError: message.isError === true,
  };
};

// -- previews ---------------------------------------------------------------

/** A one-line JSON preview of tool arguments, truncated to the head. */
export const argsPreview = (value: unknown): string => {
  if (value === undefined) return "";
  let raw: string;
  try {
    raw = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    raw = String(value);
  }
  return raw.length > 240 ? `${raw.slice(0, 240)}…` : raw;
};

/** Streamed tool output grows; render its tail. */
export const tail = (text: string, limit: number): string =>
  text.length > limit ? `…${text.slice(text.length - limit)}` : text;

/** Streamed tool partials/results: strings as-is, everything else as JSON. */
export const stringifyLive = (value: unknown): string => {
  if (value === undefined) return "";
  if (typeof value === "string") return tail(value, 1200);
  let raw: string;
  try {
    raw = JSON.stringify(value);
  } catch {
    raw = String(value);
  }
  return raw.length > 400 ? `${raw.slice(0, 400)}…` : raw;
};

/** First line of a summary (compaction, branch), truncated. */
export const summaryLine = (summary: unknown): string => {
  const text = asString(summary);
  const first = text.split("\n", 1)[0] ?? "";
  return first.length > 160 ? `${first.slice(0, 160)}…` : first;
};
