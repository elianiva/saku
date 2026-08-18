/**
 * The pi-sessions window's shared vocabulary (pi-sessions/common.ts): the
 * failure type, the data shapes, and the session-file line decoding both
 * format readers (v3.ts, v4.ts) and the window (index.ts) build on —
 * JSON object-line parsing, message text extraction (pi's own
 * extractTextContent), header classification, and the sessions root under
 * pi's agent dir.
 */

import nodePath from "node:path";
import { Option, Schema } from "effect";
import type { JsonlV4Header } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";

import type { PathsLayout } from "../paths.ts";
import type { SessionMutation } from "../session-state.ts";

/** The pi-sessions error kinds (`PiSessionsError.kind`) — single source of truth. */
export const PiSessionsErrorKinds = Schema.Literals(["scan", "not_found", "invalid"] as const);

export type PiSessionsErrorKind = typeof PiSessionsErrorKinds.Type;

/** The failures of the pi-sessions window. */
export class PiSessionsError extends Schema.TaggedError<PiSessionsError>()("PiSessionsError", {
  cause: Schema.optional(Schema.Unknown),
  kind: PiSessionsErrorKinds,
  message: Schema.String,
}) {}

/** The list view of one pi session (pi's own `buildSessionInfo` semantics). */
export interface PiSessionSummary {
  readonly id: string;
  /** Working directory where the session was started ("" for old sessions). */
  readonly cwd: string;
  /** The latest session_info name, including explicit clears; absent when never named. */
  readonly name?: string;
  readonly createdAt: number;
  readonly modifiedAt: number;
  readonly messageCount: number;
  /** The first user message's text content; "(no messages)" when none. */
  readonly firstMessage: string;
  /** Absolute path to the session file — the import key. */
  readonly path: string;
}

/** A fully parsed pi session, ready for `DoSessionRepo.import`. */
export interface PiSessionData {
  readonly id: string;
  readonly cwd: string;
  readonly createdAt: number;
  readonly name?: string;
  /** The first user/assistant message's text (adoption naming). */
  readonly firstMessage?: string;
  readonly mutations: readonly SessionMutation[];
}

/** The scanned view of one session file, before path/mtime are attached. */
export interface ScannedSession {
  id: string;
  cwd: string;
  name?: string;
  createdAt: number;
  messageCount: number;
  firstMessage: string;
}

/** A decoded JSON object line of a pi session file. */
export interface JsonLine {
  readonly [key: string]: Schema.Json;
}

/** The content payloads this reader extracts text from: decoded session
 * fields and pi's own message content. */
export type MessageContent =
  | Schema.Json
  | readonly (TextContent | ImageContent | ThinkingContent | ToolCall)[];

/** The boundary decoder for one session line: any JSON object. */
const JsonLineFromString = Schema.Record(Schema.String, Schema.Json);

/** Whether a decoded value is a JSON object line (not null, not an array;
 * undefined when the field is absent). */
export const isJsonLine = (value: MessageContent | undefined): value is JsonLine =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a value is a string (undefined when the field is absent). */
export const isString = (value: MessageContent | undefined): value is string =>
  typeof value === "string";

/** Whether a decoded field is a number (undefined when the field is absent). */
export const isNumber = (value: Schema.Json | undefined): value is number =>
  typeof value === "number";

/** Decode one session line: the object it carries, or undefined when the
 * line is blank or malformed (malformed lines are skipped, exactly like
 * pi's parser). */
export const parseLine = (line: string): JsonLine | undefined => {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  return Option.getOrUndefined(Schema.decodeUnknownOption(JsonLineFromString)(parsed));
};

/** v3 timestamps are ISO strings; v4 are epoch ms. NaN → 0 (pi falls back
 * to file times); absent → 0. */
export const toEpochMs = (value: Schema.Json | undefined) => {
  if (isNumber(value) && Number.isFinite(value)) {
    return value;
  }
  if (isString(value)) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? 0 : ms;
  }
  return 0;
};

/** Whether a decoded block is a text or image content block. */
export const isContentBlock = (
  block: Schema.Json,
): block is JsonLine & (TextContent | ImageContent) => {
  if (!isJsonLine(block)) {
    return false;
  }
  if (block.type === "text" && isString(block.text)) {
    return true;
  }
  return block.type === "image" && isString(block.data) && isString(block.mimeType);
};

/** Whether a decoded content field is message content (a string or content
 * blocks; undefined when the field is absent). */
export const isMessageContent = (
  value: Schema.Json | undefined,
): value is string | (JsonLine & (TextContent | ImageContent))[] => {
  if (isString(value)) {
    return true;
  }
  if (!Array.isArray(value)) {
    return false;
  }
  return value.every(isContentBlock);
};

/** The text content of a message (pi's extractTextContent). */
export const textContent = (content: MessageContent) => {
  if (isString(content)) {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter(
        (block: MessageContent): block is { type: "text"; text: string } =>
          isJsonLine(block) && block.type === "text",
      )
      .map((block) => block.text)
      .join(" ");
  }
  return "";
};

/** Whether an object is a message entry with user/assistant text content. */
export const firstMessageOf = (obj: JsonLine): string | undefined => {
  const { message } = obj;
  if (!isJsonLine(message)) {
    return undefined;
  }
  const { role } = message;
  if (role !== "user" && role !== "assistant") {
    return undefined;
  }
  const text = textContent(message.content ?? "");
  return text.length > 0 ? text : undefined;
};

/** The sessions root under pi's agent dir (from the caller's layout). */
export const sessionsRootOf = (paths: PathsLayout) => nodePath.join(paths.agentDir, "sessions");

/** pi's per-cwd session dir name (session-manager.ts's getDefaultSessionDirPath):
 *  `--` + the cwd minus its leading slash, with `/`, `\\`, and `:` replaced
 *  by `-`, then `--`. The encoding is lossy (a literal dash in a name is
 *  indistinguishable from a separator) — so dir names only ever pick
 *  *candidates*; the file header's real cwd is the membership check. */
export const sessionDirNameOf = (cwd: string) =>
  `--${cwd.replace(/^[/\\]/u, "").replaceAll(/[/\\:]/gu, "-")}--`;

/** The header fields the window consumes (v3 and v4 both carry them). */
export interface SessionHeader {
  readonly id: string;
  readonly cwd: string;
  readonly createdAt: number;
}

/** The v3 header line's decoded fields; undefined when the file is not a
 * v3 session. */
export const parseV3Header = (obj: JsonLine): SessionHeader | undefined => {
  if (obj.type !== "session" || !isString(obj.id)) {
    return undefined;
  }
  return {
    createdAt: toEpochMs(obj.timestamp),
    cwd: isString(obj.cwd) ? obj.cwd : "",
    id: obj.id,
  };
};

/** Whether a decoded header line is a v4 header (the fields the reader
 * consumes). */
export const isV4Header = (value: JsonLine): value is JsonLine & JsonlV4Header =>
  value.kind === "header" && value.version === 4 && isString(value.id) && isString(value.cwd);

/** The adopted-session data with the optional name/firstMessage attached
 * (both format readers end on the same assembly). */
export const sessionData = (
  base: Omit<PiSessionData, "name" | "firstMessage">,
  extras: { readonly name?: string | undefined; readonly firstMessage?: string | undefined },
): PiSessionData => {
  const data: Omit<PiSessionData, "name" | "firstMessage"> & {
    name?: string;
    firstMessage?: string;
  } = { ...base };
  if (extras.name !== undefined && extras.name.length > 0) {
    data.name = extras.name;
  }
  if (extras.firstMessage !== undefined && extras.firstMessage.length > 0) {
    data.firstMessage = extras.firstMessage;
  }
  return data;
};

/** The line facts the cheap list scan extracts (v3 and v4 shape them the
 * same; only their field names differ). */
export interface SessionLineScan {
  readonly isName: (obj: JsonLine) => boolean;
  /** The raw name value; the scan trims it and drops empties. */
  readonly nameOf: (obj: JsonLine) => string | undefined;
  readonly isMessage: (obj: JsonLine) => boolean;
}

/** The cheap list view of a session file (name/count/first message — no
 * tree). A name line with an empty or non-string name clears the name. */
export const scanLines = (
  lines: readonly string[],
  scan: SessionLineScan,
  header: SessionHeader,
): ScannedSession => {
  let name: string | undefined;
  let messageCount = 0;
  let firstMessage = "";
  for (let index = 1; index < lines.length; index += 1) {
    const obj = parseLine(lines[index] ?? "");
    if (obj === undefined) {
      continue;
    }
    if (scan.isName(obj)) {
      const trimmed = scan.nameOf(obj)?.trim() ?? "";
      name = trimmed.length > 0 ? trimmed : undefined;
    } else if (scan.isMessage(obj)) {
      messageCount += 1;
      if (firstMessage.length === 0) {
        firstMessage = firstMessageOf(obj) ?? "";
      }
    }
  }
  const summary: ScannedSession = {
    createdAt: header.createdAt,
    cwd: header.cwd,
    firstMessage: firstMessage.length > 0 ? firstMessage : "(no messages)",
    id: header.id,
    messageCount,
  };
  if (name !== undefined) {
    summary.name = name;
  }
  return summary;
};
