/**
 * Pi sessions (pi-sessions.ts): the local daemon's window into pi's own
 * session files — `~/.pi/agent/sessions/**` (the layout's `agentDir`,
 * honoring `PI_CODING_AGENT_DIR`) — listed and adopted as saku threads.
 *
 * pi's shell writes the v3 format (`CURRENT_SESSION_VERSION = 3` in pi's
 * session-manager): one jsonl file per session, a `session` header line
 * then type-keyed entry lines with no seq and no lane. pi-agent-core's own
 * `JsonlSessionRepo` only reads the newer v4 format, so this module reads
 * v3 natively (the vocabulary is frozen — pi's shell has written it for
 * its whole life) and v4 through pi's public repo.
 *
 * The v3 → saku `SessionMutation` mapping mirrors pi's own semantics
 * (session-manager.ts / messages.ts):
 *
 * - `message`, `custom`, `model_change`, `thinking_level_change`,
 *   `active_tools_change`, `branch_summary`, `compaction` → entry
 *   mutations, seq assigned in file order
 * - `custom_message` → a message entry with `message.role: "custom"`
 *   (exactly pi's `createCustomMessage`)
 * - `session_info` → name fact; `label` → label fact. These lines are
 *   chained like entries in v3, but facts are not tree nodes in the
 *   session model — their children are re-parented to the fact's parent
 *   (the fact becomes transparent)
 * - v3 has no lane info: a final `main` lane fact pins the leaf so the
 *   first prompt on the adopted thread chains onto the last message
 * - v3 compaction entries lack `retainedTail` (v4 requires it): it is
 *   synthesized from the message path `firstKeptEntryId → leaf`, the same
 *   kept region pi's own context builder computes
 *
 * Import is adoption: the mutations are replayed into the thread's own
 * trail (`DoSessionRepo.import`), and the pi file is never written. A
 * broken parent chain or duplicate id fails the import with the offending
 * line — better than a thread that breaks on first touch.
 */

import nodePath from "node:path";
import { homedir } from "node:os";
import type { FileSystem } from "effect";
import { Effect, Option, Result, Schema } from "effect";
import { FileError, JsonlSessionRepo, err, ok } from "@earendil-works/pi-agent-core";
import type {
  CustomMessage,
  Entry,
  JsonlSessionMetadata,
  JsonlSessionRepoFileSystem,
  JsonlV4Header,
  LogItem,
  MessageEntry,
} from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";

import type { PathsLayout } from "./paths.ts";
import type { SessionMutation } from "./session-state.ts";

/** Alias of `Schema.TaggedError` so oxlint's Error-name call heuristic
 * doesn't demand `new` on the factory call (which would break typecheck). */
const taggedError = Schema.TaggedError;

/** The failures of the pi-sessions window. */
export class PiSessionsError extends taggedError<PiSessionsError>()("PiSessionsError", {
  cause: Schema.optional(Schema.Unknown),
  kind: Schema.Literals(["scan", "not_found", "invalid"]),
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

/** A decoded JSON object line of a pi session file. */
interface JsonLine {
  readonly [key: string]: Schema.Json;
}

/** The content payloads this reader extracts text from: decoded session
 * fields and pi's own message content. */
type MessageContent =
  | Schema.Json
  | readonly (TextContent | ImageContent | ThinkingContent | ToolCall)[];

/** The boundary decoder for one session line: any JSON object. */
const JsonLineFromString = Schema.Record(Schema.String, Schema.Json);

/** Whether a decoded value is a JSON object line (not null, not an array;
 * undefined when the field is absent). */
const isJsonLine = (value: MessageContent | undefined): value is JsonLine =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a value is a string (undefined when the field is absent). */
const isString = (value: MessageContent | undefined): value is string => typeof value === "string";

/** Whether a decoded field is a number (undefined when the field is absent). */
const isNumber = (value: Schema.Json | undefined): value is number => typeof value === "number";

/** The scanned view of one session file, before path/mtime are attached. */
interface ScannedSession {
  id: string;
  cwd: string;
  name?: string;
  createdAt: number;
  messageCount: number;
  firstMessage: string;
}

/** The mutable state of a v3 parse, threaded through the line dispatchers. */
interface V3ParseState {
  entryOrder: Entry[];
  entriesById: Map<string, Entry>;
  factParent: Map<string, string>;
  firstMessage: string;
  lastEntryId: string | null;
  messageCount: number;
  mutations: SessionMutation[];
  name: string | undefined;
  rawLineById: Map<string, JsonLine>;
  seq: number;
}

/** The sessions root under pi's agent dir (from the caller's layout). */
const sessionsRootOf = (paths: PathsLayout) => nodePath.join(paths.agentDir, "sessions");

/** pi's per-cwd session dir name (session-manager.ts's getDefaultSessionDirPath):
 *  `--` + the cwd minus its leading slash, with `/`, `\\`, and `:` replaced
 *  by `-`, then `--`. The encoding is lossy (a literal dash in a name is
 *  indistinguishable from a separator) — so dir names only ever pick
 *  *candidates*; the file header's real cwd is the membership check. */
export const sessionDirNameOf = (cwd: string) =>
  `--${cwd.replace(/^[/\\]/u, "").replaceAll(/[/\\:]/gu, "-")}--`;

/** Decode one session line: the object it carries, or undefined when the
 * line is blank or malformed (malformed lines are skipped, exactly like
 * pi's parser). */
const parseLine = (line: string): JsonLine | undefined => {
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
const toEpochMs = (value: Schema.Json | undefined) => {
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
const isContentBlock = (block: Schema.Json): block is JsonLine & (TextContent | ImageContent) => {
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
const isMessageContent = (
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
const textContent = (content: MessageContent) => {
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
const firstMessageOf = (obj: JsonLine): string | undefined => {
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

/** The v3 header line's decoded fields. */
interface V3Header {
  readonly id: string;
  readonly cwd: string;
  readonly createdAt: number;
}

/** Classify the header line; undefined when the file is not a v3 session. */
const parseV3Header = (obj: JsonLine): V3Header | undefined => {
  if (obj.type !== "session" || !isString(obj.id)) {
    return undefined;
  }
  return {
    createdAt: toEpochMs(obj.timestamp),
    cwd: isString(obj.cwd) ? obj.cwd : "",
    id: obj.id,
  };
};

const invalid = (path: string, line: number, message: string) =>
  new PiSessionsError({
    kind: "invalid",
    message: `invalid pi session ${path}: line ${line}: ${message}`,
  });

/** The v3 entry line types that are tree nodes (facts and unknown types are not). */
const V3_ENTRY_TYPES = new Set([
  "message",
  "model_change",
  "thinking_level_change",
  "active_tools_change",
  "branch_summary",
  "compaction",
  "custom",
]);

/** Whether a built entry object is a session entry of the frozen v3
 *  vocabulary. The discriminant and core fields (type/id/parentId) are
 *  validated here; type-specific payload fields ride along verbatim, the
 *  same trust pi's own parser applies to its files. */
const isEntry = (value: Entry | JsonLine): value is Entry => {
  if (!isString(value.type) || !V3_ENTRY_TYPES.has(value.type)) {
    return false;
  }
  if (!isString(value.id) || value.id.length === 0) {
    return false;
  }
  const { parentId } = value;
  return parentId === null || isString(parentId);
};

/** Whether a decoded header line is a v4 header (the fields the reader consumes). */
const isV4Header = (value: JsonLine): value is JsonLine & JsonlV4Header =>
  value.kind === "header" && value.version === 4 && isString(value.id) && isString(value.cwd);

/** The cheap list view of a v3 file (name/count/first message — no tree). */
const scanV3Lines = (path: string, lines: readonly string[]): ScannedSession | undefined => {
  const header = parseV3Header(parseLine(lines[0] ?? "") ?? {});
  if (header === undefined) {
    return undefined;
  }
  let name: string | undefined;
  let messageCount = 0;
  let firstMessage = "";
  for (let index = 1; index < lines.length; index += 1) {
    const obj = parseLine(lines[index] ?? "");
    if (obj === undefined) {
      continue;
    }
    if (obj.type === "session_info") {
      const trimmed = isString(obj.name) ? obj.name.trim() : "";
      name = trimmed.length > 0 ? trimmed : undefined;
    } else if (obj.type === "message") {
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

/** The cheap list view of a v4 file (the header line is already decoded). */
const scanV4Lines = (header: JsonlV4Header, lines: readonly string[]) => {
  let name: string | undefined;
  let messageCount = 0;
  let firstMessage = "";
  for (let index = 1; index < lines.length; index += 1) {
    const obj = parseLine(lines[index] ?? "");
    if (obj === undefined) {
      continue;
    }
    if (obj.kind === "fact" && obj.fact === "name" && isString(obj.name)) {
      const trimmed = obj.name.trim();
      name = trimmed.length > 0 ? trimmed : undefined;
    } else if (obj.kind === "entry" && obj.type === "message") {
      messageCount += 1;
      if (firstMessage.length === 0) {
        firstMessage = firstMessageOf(obj) ?? "";
      }
    }
  }
  const summary: ScannedSession = {
    createdAt: toEpochMs(header.createdAt),
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

/** Follow a fact's parent chain to the first non-fact ancestor. */
const resolveParent = (state: V3ParseState, id: string) => {
  let current = id;
  const visited = new Set<string>();
  while (state.factParent.has(current) && !visited.has(current)) {
    visited.add(current);
    const parent = state.factParent.get(current);
    if (parent === undefined) {
      break;
    }
    current = parent;
  }
  return current;
};

/** Register one v3 entry line: validate id/parent, assign seq, run the builder. */
const registerEntry = (
  state: V3ParseState,
  path: string,
  obj: JsonLine,
  line: number,
  type: string,
  build: (id: string, resolvedParent: string | null, timestamp: number, seq: number) => Entry,
) => {
  const { id } = obj;
  if (!isString(id) || id.length === 0) {
    throw invalid(path, line, "entry has no id");
  }
  if (state.entriesById.has(id)) {
    throw invalid(path, line, `duplicate entry id ${id}`);
  }
  const { parentId } = obj;
  if (parentId !== null && !isString(parentId)) {
    throw invalid(path, line, "entry has an invalid parentId");
  }
  const resolvedParent = isString(parentId) ? resolveParent(state, parentId) : null;
  if (resolvedParent !== null && !state.entriesById.has(resolvedParent)) {
    throw invalid(path, line, `entry chains to unknown parent ${resolvedParent}`);
  }
  state.seq += 1;
  const entry = build(id, resolvedParent, toEpochMs(obj.timestamp), state.seq);
  state.mutations.push({ entry, kind: "entry" });
  state.entriesById.set(id, entry);
  state.entryOrder.push(entry);
  state.rawLineById.set(id, obj);
  state.lastEntryId = id;
};

/** Apply a session_info/label line (a fact); true when the line was a fact. */
const applyFactLine = (path: string, line: number, obj: JsonLine, state: V3ParseState) => {
  const { type } = obj;
  if (type === "session_info") {
    const { id } = obj;
    const { parentId } = obj;
    if (!isString(id) || parentId === null || !isString(parentId)) {
      throw invalid(path, line, "session_info entry has invalid id/parentId");
    }
    if (state.factParent.has(id)) {
      throw invalid(path, line, `duplicate entry id ${id}`);
    }
    state.factParent.set(id, parentId);
    const trimmed = isString(obj.name) ? obj.name.trim() : "";
    state.seq += 1;
    state.mutations.push({ fact: "name", kind: "fact", name: trimmed, seq: state.seq });
    state.name = trimmed.length > 0 ? trimmed : undefined;
    return true;
  }
  if (type === "label") {
    const { id } = obj;
    const { parentId } = obj;
    const { targetId } = obj;
    if (!isString(id) || parentId === null || !isString(parentId) || !isString(targetId)) {
      throw invalid(path, line, "label entry has invalid id/parentId/targetId");
    }
    if (state.factParent.has(id)) {
      throw invalid(path, line, `duplicate entry id ${id}`);
    }
    state.factParent.set(id, parentId);
    state.seq += 1;
    state.mutations.push({
      fact: "label",
      kind: "fact",
      label: isString(obj.label) ? obj.label : undefined,
      seq: state.seq,
      targetId,
    });
    return true;
  }
  return false;
};

/** Replay one decoded v3 line into the parse state (throws PiSessionsError). */
const applyV3Line = (path: string, line: number, obj: JsonLine, state: V3ParseState) => {
  const { type } = obj;
  if (!isString(type)) {
    return;
  }
  if (applyFactLine(path, line, obj, state)) {
    return;
  }
  if (type === "custom_message") {
    // pi projects custom_message lines as role-custom messages
    // (createCustomMessage); in the session model they are message
    // entries, so they participate in the tree like any message.
    registerEntry(state, path, obj, line, "message", (id, resolvedParent, timestamp, seq) => {
      const message: CustomMessage = {
        content: isMessageContent(obj.content) ? obj.content : [],
        customType: isString(obj.customType) ? obj.customType : "",
        display: obj.display === true,
        role: "custom",
        timestamp,
      };
      if (obj.details !== undefined) {
        message.details = obj.details;
      }
      return { id, message, parentId: resolvedParent, seq, timestamp, type: "message" };
    });
    return;
  }
  if (V3_ENTRY_TYPES.has(type)) {
    registerEntry(state, path, obj, line, type, (id, resolvedParent, timestamp, seq) => {
      const { type: _type, id: _id, parentId: _parentId, timestamp: _timestamp, ...fields } = obj;
      const entry = { ...fields, id, parentId: resolvedParent, seq, timestamp, type };
      if (!isEntry(entry)) {
        throw invalid(path, line, "entry line has an invalid shape");
      }
      return entry;
    });
    if (type === "message") {
      state.messageCount += 1;
      if (state.firstMessage.length === 0) {
        state.firstMessage = firstMessageOf(obj) ?? "";
      }
    }
  }
  // Unknown types are skipped (pi's parser keeps them out of the tree).
};

/** Synthesize compaction retainedTail (v4 requires it; v3 files carry only
 * firstKeptEntryId). The kept region is pi's own context rule: from
 * firstKeptEntryId → leaf, the compaction entry itself excluded. */
const synthesizeRetainedTails = (state: V3ParseState, pathRootFirst: readonly Entry[]) => {
  for (const entry of state.entryOrder) {
    if (entry.type !== "compaction") {
      continue;
    }
    const compactionIdx = pathRootFirst.findIndex((e) => e.id === entry.id);
    let startIdx = compactionIdx + 1;
    const firstKept = state.rawLineById.get(entry.id)?.firstKeptEntryId;
    if (firstKept !== undefined && isString(firstKept)) {
      const firstKeptIdx = pathRootFirst.findIndex((e) => e.id === firstKept);
      if (firstKeptIdx !== -1 && firstKeptIdx < compactionIdx) {
        startIdx = firstKeptIdx;
      }
    }
    entry.retainedTail = pathRootFirst
      .slice(startIdx)
      .filter((e): e is MessageEntry => e.type === "message")
      .map((e) => e.message);
  }
};

/**
 * Parse a v3 session file into adoptable mutations. Total for well-formed
 * input; `PiSessionsError` carries the offending line when the chain cannot
 * be replayed (broken parent, duplicate id).
 */
const parseV3 = (path: string, lines: readonly string[]) =>
  Result.try({
    catch: (error) =>
      error instanceof PiSessionsError
        ? error
        : new PiSessionsError({
            cause: error,
            kind: "invalid",
            message: `${path}: ${error instanceof Error ? error.message : String(error)}`,
          }),
    try: () => {
      const header = parseV3Header(parseLine(lines[0] ?? "") ?? {});
      if (header === undefined) {
        throw new PiSessionsError({
          kind: "invalid",
          message: `${path}: not a pi session file (expected a "session" header)`,
        });
      }
      const state: V3ParseState = {
        entriesById: new Map(),
        entryOrder: [],
        factParent: new Map(),
        firstMessage: "",
        lastEntryId: null,
        messageCount: 0,
        mutations: [],
        name: undefined,
        rawLineById: new Map(),
        seq: 0,
      };
      // Pass 1: decode lines. Fact lines (session_info/label) are chained
      // like entries in v3 but are not tree nodes in the session model —
      // remember their parent so their children re-parent through them.
      const raw: { line: number; obj: JsonLine }[] = [];
      for (let index = 1; index < lines.length; index += 1) {
        const obj = parseLine(lines[index] ?? "");
        if (obj === undefined || !isString(obj.type)) {
          continue;
        }
        raw.push({ line: index + 1, obj });
      }
      // Pass 2: build mutations in file order (seqs assigned here; v3 has none).
      for (const { line, obj } of raw) {
        applyV3Line(path, line, obj, state);
      }
      const pathLeafFirst: Entry[] = [];
      {
        const visited = new Set<string>();
        let current: string | null = state.lastEntryId;
        while (current !== null && !visited.has(current)) {
          visited.add(current);
          const entry = state.entriesById.get(current);
          if (entry === undefined) {
            break;
          }
          pathLeafFirst.push(entry);
          current = entry.parentId;
        }
      }
      synthesizeRetainedTails(state, [...pathLeafFirst].toReversed());

      // Pin the main lane so the first prompt chains onto the last message
      // (v3 has no lane info; without it the lane leaf stays null).
      if (state.lastEntryId !== null) {
        state.seq += 1;
        state.mutations.push({
          kind: "lane",
          lane: "main",
          leafId: state.lastEntryId,
          seq: state.seq,
        });
      }

      let data: PiSessionData = {
        createdAt: header.createdAt,
        cwd: header.cwd,
        id: header.id,
        mutations: state.mutations,
      };
      if (state.name !== undefined) {
        data = { ...data, name: state.name };
      }
      if (state.firstMessage.length > 0) {
        data = { ...data, firstMessage: state.firstMessage };
      }
      return data;
    },
  });

/** The promise FileSystem seam pi's repo needs, over the effect FileSystem
 * service (the same adapter shape as LocalEnv). Failures are conduits for
 * the repo's own error reporting — the errno taxonomy is not needed here. */
const fail = (path: string, error: Error) =>
  new FileError(
    "unknown",
    `filesystem error: ${error instanceof Error ? error.message : String(error)}`,
    path,
  );

const jsonlFsOf = (fs: FileSystem.FileSystem): JsonlSessionRepoFileSystem => ({
  absolutePath: async (filePath) => {
    const outcome = await Effect.runPromise(
      Effect.succeed(nodePath.resolve(filePath)).pipe(Effect.result),
    );
    return Result.isSuccess(outcome) ? ok(outcome.success) : err(fail(filePath, outcome.failure));
  },
  appendFile: async (filePath, content) => {
    const outcome = await Effect.runPromise(
      fs
        .writeFileString(filePath, Buffer.from(content).toString(), { flag: "a" })
        .pipe(Effect.result),
    );
    return Result.isSuccess(outcome)
      ? ok(undefined satisfies undefined)
      : err(fail(filePath, outcome.failure));
  },
  createDir: async (filePath, options) => {
    const outcome = await Effect.runPromise(
      fs.makeDirectory(filePath, { recursive: options?.recursive ?? true }).pipe(Effect.result),
    );
    return Result.isSuccess(outcome)
      ? ok(undefined satisfies undefined)
      : err(fail(filePath, outcome.failure));
  },
  exists: async (filePath) => {
    const outcome = await Effect.runPromise(fs.exists(filePath).pipe(Effect.result));
    return Result.isSuccess(outcome) ? ok(outcome.success) : err(fail(filePath, outcome.failure));
  },
  fileInfo: async (filePath) => {
    const outcome = await Effect.runPromise(
      fs.stat(filePath).pipe(
        Effect.map((info) => ({
          kind: info.type === "Directory" ? ("directory" as const) : ("file" as const),
          mtimeMs: Option.isSome(info.mtime) ? info.mtime.value.getTime() : 0,
          name: filePath.split("/").pop() ?? filePath,
          path: filePath,
          size: Number(info.size),
        })),
        Effect.result,
      ),
    );
    return Result.isSuccess(outcome) ? ok(outcome.success) : err(fail(filePath, outcome.failure));
  },
  joinPath: async (parts) => {
    const outcome = await Effect.runPromise(Effect.succeed(parts.join("/")).pipe(Effect.result));
    return Result.isSuccess(outcome)
      ? ok(outcome.success)
      : err(fail(parts.join("/"), outcome.failure));
  },
  listDir: async (filePath) => {
    const outcome = await Effect.runPromise(fs.readDirectory(filePath).pipe(Effect.result));
    return Result.isSuccess(outcome)
      ? ok(
          outcome.success.map((name) => ({
            kind: "file" as const,
            mtimeMs: 0,
            name,
            path: `${filePath}/${name}`,
            size: 0,
          })),
        )
      : err(fail(filePath, outcome.failure));
  },
  readTextFile: async (filePath) => {
    const outcome = await Effect.runPromise(fs.readFileString(filePath).pipe(Effect.result));
    return Result.isSuccess(outcome) ? ok(outcome.success) : err(fail(filePath, outcome.failure));
  },
  remove: async (filePath, options) => {
    const outcome = await Effect.runPromise(
      fs
        .remove(filePath, {
          force: options?.force ?? false,
          recursive: options?.recursive ?? false,
        })
        .pipe(Effect.result),
    );
    return Result.isSuccess(outcome)
      ? ok(undefined satisfies undefined)
      : err(fail(filePath, outcome.failure));
  },
  renameFile: async (sourcePath, destinationPath) => {
    const outcome = await Effect.runPromise(
      fs.rename(sourcePath, destinationPath).pipe(Effect.result),
    );
    return Result.isSuccess(outcome)
      ? ok(undefined satisfies undefined)
      : err(fail(sourcePath, outcome.failure));
  },
  writeFile: async (filePath, content) => {
    const outcome = await Effect.runPromise(
      fs.writeFileString(filePath, Buffer.from(content).toString()).pipe(Effect.result),
    );
    return Result.isSuccess(outcome)
      ? ok(undefined satisfies undefined)
      : err(fail(filePath, outcome.failure));
  },
});

/** v4 log items are the same mutation vocabulary with seq hoisted and lane
 * dropped from entries — normalize to saku's SessionMutation. */
const logItemToMutation = (item: LogItem): SessionMutation => {
  if (item.kind === "entry") {
    return { entry: item.entry, kind: "entry" };
  }
  if (item.kind === "record") {
    return { kind: "record", record: item.record };
  }
  return item;
};

/** Scan one session file into its summary; Option.none when it is not a
 * readable pi session (pi's own list skips those silently). */
const scanFile = Effect.fn("scanFile")(function* scanFile(fs: FileSystem.FileSystem, path: string) {
  const content = yield* fs.readFileString(path).pipe(Effect.catch(() => Effect.succeed("")));
  if (content.length === 0) {
    return Option.none();
  }
  const lines = content.split("\n");
  const first = parseLine(lines[0] ?? "");
  if (first === undefined) {
    return Option.none();
  }
  const v3Summary = first.type === "session" ? scanV3Lines(path, lines) : undefined;
  const v4Summary = isV4Header(first) ? scanV4Lines(first, lines) : undefined;
  const summary = v3Summary ?? v4Summary;
  if (summary === undefined) {
    return Option.none();
  }
  const stat = yield* fs
    .stat(path)
    .pipe(Effect.catch(() => Effect.succeed(undefined satisfies undefined)));
  return Option.some({
    ...summary,
    modifiedAt:
      stat !== undefined && Option.isSome(stat.mtime)
        ? stat.mtime.value.getTime()
        : summary.createdAt,
    path,
  });
});

/** Whether a session's real cwd sits under the given projects (the header
 *  verification: dir names are lossy, the header's cwd is not). Sessions
 *  from before cwd was recorded ("") pass on their dir match alone. */
const underProjects = (cwd: string, projects: readonly { path: string }[]) => {
  if (cwd.length === 0) {
    return true;
  }
  const resolved = nodePath.resolve(cwd);
  return projects.some(
    (project) => resolved === project.path || resolved.startsWith(`${project.path}/`),
  );
};

/** The picker's candidate cwds: every cwd pi has sessions for, decoded
 *  lossily from the session dir names (the encoding can't distinguish
 *  dashes from separators — good enough for a picker; the added path is
 *  what the user commits). No file reads. */
const listProjectCandidates = Effect.fn("listProjectCandidates")(function* listProjectCandidates(
  fs: FileSystem.FileSystem,
  paths: PathsLayout,
): Effect.fn.Return<readonly string[], PiSessionsError> {
  const root = sessionsRootOf(paths);
  const dirs = yield* fs.readDirectory(root).pipe(Effect.catch(() => Effect.succeed([])));
  return dirs
    .map((dir) => `/${dir.slice(2, -2).replaceAll("-", "/")}`)
    .filter((decoded) => decoded !== "/" && decoded.length > 1)
    .toSorted();
});

/** The deepest common ancestor of a set of absolute paths (the picker's
 *  opening level); undefined when the set is empty. */
const commonRootOf = (paths: readonly string[]): string | undefined => {
  const segments = paths.map((path) => path.split("/").filter(Boolean));
  const common: string[] = [];
  const [first] = segments;
  if (first === undefined) {
    return undefined;
  }
  for (let index = 0; index < first.length; index += 1) {
    const segment = first[index];
    if (segment !== undefined && segments.every((parts) => parts[index] === segment)) {
      common.push(segment);
    } else {
      break;
    }
  }
  return common.length === 0 ? "/" : `/${common.join("/")}`;
};

/** The picker's opening level: the deepest common ancestor of the
 *  candidates (their projects are one or two levels down, badges visible),
 *  or the home directory when pi has no sessions yet. */
const defaultRootOf = (candidates: readonly string[], home: string) => {
  if (candidates.length === 0) {
    return home;
  }
  const single = candidates.length === 1 ? candidates[0] : undefined;
  return single === undefined ? (commonRootOf(candidates) ?? home) : nodePath.dirname(single);
};

/** One level of the add-project tree (CONTEXT.md: Add project): the
 *  subdirectories of `input` ("" opens the picker's default root), each
 *  marked with whether pi has sessions for that exact cwd. The tree is
 *  traversed level by level from the picker — the daemon never returns the
 *  whole tree, only the level asked for. */
export const browseProjectDirs = Effect.fn("browseProjectDirs")(function* browseProjectDirs(
  fs: FileSystem.FileSystem,
  paths: PathsLayout,
  input: string,
): Effect.fn.Return<
  {
    readonly path: string;
    readonly parent: string | null;
    readonly entries: readonly {
      readonly name: string;
      readonly path: string;
      readonly hasPiSessions: boolean;
    }[];
  },
  PiSessionsError
> {
  const candidates = yield* listProjectCandidates(fs, paths);
  const candidateSet = new Set(candidates);
  const root =
    input.trim().length === 0
      ? defaultRootOf(candidates, homedir())
      : nodePath.resolve(input.trim());
  const names = yield* fs.readDirectory(root).pipe(
    Effect.mapError(
      (error) =>
        new PiSessionsError({
          cause: error,
          kind: "scan",
          message: `cannot list ${root}: ${error instanceof Error ? error.message : String(error)}`,
        }),
    ),
  );
  const entries: {
    name: string;
    path: string;
    hasPiSessions: boolean;
  }[] = [];
  for (const name of names) {
    const path = nodePath.join(root, name);
    const stat = yield* fs
      .stat(path)
      .pipe(Effect.catch(() => Effect.succeed(undefined satisfies undefined)));
    if (stat === undefined || stat.type !== "Directory") {
      continue;
    }
    entries.push({ hasPiSessions: candidateSet.has(path), name, path });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { entries, parent: root === "/" ? null : nodePath.dirname(root), path: root };
});

/**
 * List the pi sessions under the given projects, newest first. The projects
 * are the scope of the window (CONTEXT.md: Project): only their session
 * dirs are read (dir-name prefix match — zero file reads for anything
 * else), and every listed session's header cwd is verified to sit under a
 * project, so pi's lossy dir encoding can never misattribute a session.
 * An empty project list is an empty window — nothing is scanned.
 */
export const listPiSessions = Effect.fn("listPiSessions")(function* listPiSessions(
  fs: FileSystem.FileSystem,
  paths: PathsLayout,
  projects: readonly string[],
): Effect.fn.Return<readonly PiSessionSummary[], PiSessionsError> {
  if (projects.length === 0) {
    return [];
  }
  const root = sessionsRootOf(paths);
  const encoded = projects.map((path) => ({ dir: sessionDirNameOf(path), path }));
  const dirs = yield* fs.readDirectory(root).pipe(Effect.catch(() => Effect.succeed([])));
  const candidates = dirs.filter((dir) =>
    encoded.some(
      ({ dir: projectDir }) => dir === projectDir || dir.startsWith(`${projectDir.slice(0, -2)}-`),
    ),
  );
  const files: string[] = [];
  for (const dir of candidates) {
    const entries = yield* fs
      .readDirectory(`${root}/${dir}`)
      .pipe(Effect.catch(() => Effect.succeed([])));
    for (const entry of entries) {
      if (entry.endsWith(".jsonl")) {
        files.push(`${root}/${dir}/${entry}`);
      }
    }
  }
  const scanned = yield* Effect.forEach(files, (path) => scanFile(fs, path), {
    concurrency: 10,
  });
  return scanned
    .filter((entry): entry is Option.Some<PiSessionSummary> => Option.isSome(entry))
    .map((entry) => entry.value)
    .filter((session) => underProjects(session.cwd, encoded))
    .toSorted((a, b) => b.modifiedAt - a.modifiedAt);
});

/** Adopt a v4 file through pi-agent-core's own repo (its codec, its repair). */
const readV4 = (
  fs: FileSystem.FileSystem,
  paths: PathsLayout,
  path: string,
  header: JsonlV4Header,
) =>
  Effect.tryPromise({
    catch: (error) =>
      error instanceof PiSessionsError
        ? error
        : new PiSessionsError({
            cause: error,
            kind: "invalid",
            message: `invalid pi session ${path}: ${error instanceof Error ? error.message : String(error)}`,
          }),
    try: async () => {
      // The header is already decoded here; build the metadata directly —
      // the repo's own list() would throw on the v3 files that share the
      // sessions root (its codec is v4-only).
      const metadata: JsonlSessionMetadata = {
        createdAt: toEpochMs(header.createdAt),
        cwd: header.cwd,
        id: header.id,
        modifiedAt: Date.now(),
        path,
        sourceFormat: 4,
      };
      const repo = new JsonlSessionRepo({
        fs: jsonlFsOf(fs),
        sessionsRoot: sessionsRootOf(paths),
      });
      const session = await repo.open(metadata);
      const log = await session.getLog();
      const lanes = await session.getLanes();
      const mutations: SessionMutation[] = log.map(logItemToMutation);
      // v4 encodes the main lane leaf on entry lines; the log strips it —
      // re-pin every lane so continuation chains onto the last message.
      let seq = log.at(-1)?.seq ?? 0;
      for (const pointer of lanes) {
        seq += 1;
        mutations.push({ kind: "lane", lane: pointer.lane, leafId: pointer.leafId, seq });
      }
      const name = log.findLast(
        (item): item is Extract<LogItem, { readonly kind: "fact"; readonly fact: "name" }> =>
          item.kind === "fact" && item.fact === "name",
      )?.name;
      let firstMessage = "";
      const firstMessageEntry = log.find(
        (
          item,
        ): item is Extract<LogItem, { readonly kind: "entry" }> & {
          readonly entry: MessageEntry;
        } =>
          item.kind === "entry" &&
          item.entry.type === "message" &&
          (item.entry.message.role === "user" || item.entry.message.role === "assistant"),
      );
      if (firstMessageEntry !== undefined) {
        const { message } = firstMessageEntry.entry;
        if (message.role === "user" || message.role === "assistant") {
          firstMessage = textContent(message.content);
        }
      }
      let data: PiSessionData = {
        createdAt: metadata.createdAt,
        cwd: metadata.cwd,
        id: metadata.id,
        mutations,
      };
      if (name !== undefined && name.length > 0) {
        data = { ...data, name };
      }
      if (firstMessage.length > 0) {
        data = { ...data, firstMessage };
      }
      return data;
    },
  });

/** Parse one pi session file for adoption (v3 natively, v4 via pi's repo). */
export const readPiSession = Effect.fn("readPiSession")(function* readPiSession(
  fs: FileSystem.FileSystem,
  paths: PathsLayout,
  path: string,
) {
  const content = yield* fs.readFileString(path).pipe(
    Effect.mapError(
      (error) =>
        new PiSessionsError({
          cause: error,
          kind: "not_found",
          message: `cannot read pi session ${path}: ${error instanceof Error ? error.message : String(error)}`,
        }),
    ),
  );
  const lines = content.split("\n");
  const first = parseLine(lines[0] ?? "");
  if (first === undefined) {
    return yield* Effect.fail(
      new PiSessionsError({ kind: "invalid", message: `${path}: not a pi session file` }),
    );
  }
  if (first.type === "session") {
    const outcome = parseV3(path, lines);
    if (Result.isFailure(outcome)) {
      return yield* Effect.fail(outcome.failure);
    }
    return outcome.success;
  }
  if (isV4Header(first)) {
    return yield* readV4(fs, paths, path, first);
  }
  return yield* Effect.fail(
    new PiSessionsError({ kind: "invalid", message: `${path}: not a pi session file` }),
  );
});
