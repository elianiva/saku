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

import { join, resolve } from "node:path";
import { Effect, FileSystem, Option, Result, Schema } from "effect";
import {
  JsonlSessionRepo,
  type AgentMessage,
  type Entry,
  FileError,
  err,
  ok,
  type JsonlSessionMetadata,
  type JsonlSessionRepoFileSystem,
  type FileInfo,
  type LogItem,
  type MessageEntry,
  type Result as PiResult,
} from "@earendil-works/pi-agent-core";

import type { PathsShape } from "./paths.ts";
import type { SessionMutation } from "./session-state.ts";

/** The failures of the pi-sessions window. */
export class PiSessionsError extends Schema.TaggedError<PiSessionsError>()("PiSessionsError", {
  kind: Schema.Literals(["scan", "not_found", "invalid"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
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

/** The sessions root under pi's agent dir (from the caller's layout). */
const sessionsRootOf = (paths: PathsShape) => join(paths.agentDir, "sessions");

const parseLine = (line: string) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined; // malformed lines are skipped, exactly like pi's parser
  }
};

/** v3 timestamps are ISO strings; v4 are epoch ms. NaN → 0 (pi falls back to file times). */
const toEpochMs = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? 0 : ms;
  }
  return 0;
};

/** The text content of a message (pi's extractTextContent). */
const textContent = (content: unknown) => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (block): block is { type: "text"; text: string } =>
          typeof block === "object" &&
          block !== null &&
          (block as { type?: string }).type === "text",
      )
      .map((block) => block.text)
      .join(" ");
  }
  return "";
};

/** Whether an object is a message entry with user/assistant text content. */
const firstMessageOf = (obj: Record<string, unknown>) => {
  const message = obj.message;
  if (typeof message !== "object" || message === null) return undefined;
  const role = (message as { role?: unknown }).role;
  if (role !== "user" && role !== "assistant") return undefined;
  const text = textContent((message as { content?: unknown }).content);
  return text.length > 0 ? text : undefined;
};

interface V3Header {
  readonly id: string;
  readonly cwd: string;
  readonly createdAt: number;
}

/** Classify the header line; undefined when the file is not a v3 session. */
const parseV3Header = (obj: Record<string, unknown>) => {
  if (obj.type !== "session" || typeof obj.id !== "string") return undefined;
  return {
    id: obj.id,
    cwd: typeof obj.cwd === "string" ? obj.cwd : "",
    createdAt: toEpochMs(obj.timestamp),
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

/** The cheap list view of a v3 file (name/count/first message — no tree). */
const scanV3Lines = (
  path: string,
  lines: readonly string[],
) => {
  const header = parseV3Header(parseLine(lines[0] ?? "") ?? {});
  if (header === undefined) return undefined;
  let name: string | undefined;
  let messageCount = 0;
  let firstMessage = "";
  for (let index = 1; index < lines.length; index++) {
    const obj = parseLine(lines[index] ?? "");
    if (obj === undefined) continue;
    if (obj.type === "session_info") {
      const trimmed = typeof obj.name === "string" ? obj.name.trim() : "";
      if (trimmed.length > 0) name = trimmed;
      else name = undefined;
    } else if (obj.type === "message") {
      messageCount += 1;
      if (firstMessage.length === 0) {
        firstMessage = firstMessageOf(obj) ?? "";
      }
    }
  }
  return {
    id: header.id,
    cwd: header.cwd,
    ...(name === undefined ? {} : { name }),
    createdAt: header.createdAt,
    messageCount,
    firstMessage: firstMessage.length > 0 ? firstMessage : "(no messages)",
  };
};

/**
 * Parse a v3 session file into adoptable mutations. Total for well-formed
 * input; `PiSessionsError` carries the offending line when the chain cannot
 * be replayed (broken parent, duplicate id).
 */
const parseV3 = (
  path: string,
  lines: readonly string[],
) =>
  Result.try({
    try: () => {
      const header = parseV3Header(parseLine(lines[0] ?? "") ?? {});
      if (header === undefined) {
        throw new PiSessionsError({
          kind: "invalid",
          message: `${path}: not a pi session file (expected a "session" header)`,
        });
      }
      // Pass 1: decode lines. Fact lines (session_info/label) are chained
      // like entries in v3 but are not tree nodes in the session model —
      // remember their parent so their children re-parent through them.
      const factParent = new Map<string, string>();
      const raw: { line: number; obj: Record<string, unknown> }[] = [];
      for (let index = 1; index < lines.length; index++) {
        const obj = parseLine(lines[index] ?? "");
        if (obj === undefined || typeof obj.type !== "string") continue;
        raw.push({ line: index + 1, obj });
      }
      const resolveParent = (id: string) => {
        let current = id;
        const visited = new Set<string>();
        while (factParent.has(current) && !visited.has(current)) {
          visited.add(current);
          const parent = factParent.get(current);
          if (parent === undefined) break;
          current = parent;
        }
        return current;
      };

      // Pass 2: build mutations in file order (seqs assigned here; v3 has none).
      let seq = 0;
      let name: string | undefined;
      let messageCount = 0;
      let firstMessage = "";
      const mutations: SessionMutation[] = [];
      const entriesById = new Map<string, Entry>();
      const entryOrder: Entry[] = [];
      let lastEntryId: string | null = null;

      const registerEntry = (
        obj: Record<string, unknown>,
        line: number,
        type: string,
        build: (resolvedParent: string | null, timestamp: number, seq: number) => Entry,
      ) => {
        const id = obj.id;
        if (typeof id !== "string" || id.length === 0) {
          throw invalid(path, line, "entry has no id");
        }
        if (entriesById.has(id)) throw invalid(path, line, `duplicate entry id ${id}`);
        const parentId = obj.parentId;
        if (parentId !== null && typeof parentId !== "string") {
          throw invalid(path, line, "entry has an invalid parentId");
        }
        const resolvedParent = typeof parentId === "string" ? resolveParent(parentId) : null;
        if (resolvedParent !== null && !entriesById.has(resolvedParent)) {
          throw invalid(path, line, `entry chains to unknown parent ${resolvedParent}`);
        }
        const entry = build(resolvedParent, toEpochMs(obj.timestamp), ++seq);
        mutations.push({ kind: "entry", entry });
        entriesById.set(id, entry);
        entryOrder.push(entry);
        lastEntryId = id;
      };

      for (const { line, obj } of raw) {
        const type = obj.type;
        if (typeof type !== "string") continue;
        if (type === "session_info") {
          const id = obj.id;
          const parentId = obj.parentId;
          if (typeof id !== "string" || parentId === null || typeof parentId !== "string") {
            throw invalid(path, line, "session_info entry has invalid id/parentId");
          }
          if (factParent.has(id)) throw invalid(path, line, `duplicate entry id ${id}`);
          factParent.set(id, parentId);
          const trimmed = typeof obj.name === "string" ? obj.name.trim() : "";
          mutations.push({ kind: "fact", seq: ++seq, fact: "name", name: trimmed });
          if (trimmed.length > 0) name = trimmed;
          else name = undefined;
        } else if (type === "label") {
          const id = obj.id;
          const parentId = obj.parentId;
          const targetId = obj.targetId;
          if (
            typeof id !== "string" ||
            parentId === null ||
            typeof parentId !== "string" ||
            typeof targetId !== "string"
          ) {
            throw invalid(path, line, "label entry has invalid id/parentId/targetId");
          }
          if (factParent.has(id)) throw invalid(path, line, `duplicate entry id ${id}`);
          factParent.set(id, parentId);
          mutations.push({
            kind: "fact",
            seq: ++seq,
            fact: "label",
            targetId,
            label: typeof obj.label === "string" ? obj.label : undefined,
          });
        } else if (type === "custom_message") {
          // pi projects custom_message lines as role-custom messages
          // (createCustomMessage); in the session model they are message
          // entries, so they participate in the tree like any message.
          registerEntry(obj, line, "message", (resolvedParent, timestamp, seq) => {
            const message = {
              role: "custom",
              customType: typeof obj.customType === "string" ? obj.customType : "",
              content: obj.content ?? [],
              display: obj.display === true,
              ...(obj.details === undefined ? {} : { details: obj.details }),
              timestamp,
            } as unknown as AgentMessage;
            return {
              type: "message",
              id: obj.id as string,
              parentId: resolvedParent,
              seq,
              timestamp,
              message,
            } as unknown as MessageEntry;
          });
          // pi's list view counts only `message`-typed lines.
        } else if (V3_ENTRY_TYPES.has(type)) {
          registerEntry(obj, line, type, (resolvedParent, timestamp, seq) => {
            const {
              type: _type,
              id: _id,
              parentId: _parentId,
              timestamp: _timestamp,
              ...fields
            } = obj;
            return {
              ...fields,
              type,
              id: obj.id as string,
              parentId: resolvedParent,
              seq,
              timestamp,
            } as unknown as Entry;
          });
          if (type === "message") {
            messageCount += 1;
            if (firstMessage.length === 0) firstMessage = firstMessageOf(obj) ?? "";
          }
        }
        // Unknown types are skipped (pi's parser keeps them out of the tree).
      }

      // Synthesize compaction retainedTail (v4 requires it; v3 files carry
      // only firstKeptEntryId). The kept region is pi's own context rule:
      // from firstKeptEntryId → leaf, the compaction entry itself excluded.
      const pathLeafFirst: Entry[] = [];
      {
        const visited = new Set<string>();
        let current: string | null = lastEntryId;
        while (current !== null && !visited.has(current)) {
          visited.add(current);
          const entry = entriesById.get(current);
          if (entry === undefined) break;
          pathLeafFirst.push(entry);
          current = entry.parentId;
        }
      }
      const pathRootFirst = [...pathLeafFirst].reverse();
      for (const entry of entryOrder) {
        if (entry.type !== "compaction") continue;
        const compactionIdx = pathRootFirst.findIndex((e) => e.id === entry.id);
        let startIdx = compactionIdx + 1;
        const firstKeptEntryId = (entry as Entry & { firstKeptEntryId?: unknown }).firstKeptEntryId;
        if (typeof firstKeptEntryId === "string") {
          const firstKeptIdx = pathRootFirst.findIndex((e) => e.id === firstKeptEntryId);
          if (firstKeptIdx !== -1 && firstKeptIdx < compactionIdx) startIdx = firstKeptIdx;
        }
        const retainedTail = pathRootFirst
          .slice(startIdx)
          .filter((e): e is MessageEntry => e.type === "message")
          .map((e) => e.message);
        (entry as { retainedTail: AgentMessage[] }).retainedTail = retainedTail;
      }

      // Pin the main lane so the first prompt chains onto the last message
      // (v3 has no lane info; without it the lane leaf stays null).
      if (lastEntryId !== null) {
        mutations.push({ kind: "lane", seq: ++seq, lane: "main", leafId: lastEntryId });
      }

      return {
        id: header.id,
        cwd: header.cwd,
        createdAt: header.createdAt,
        ...(name === undefined ? {} : { name }),
        ...(firstMessage.length > 0 ? { firstMessage } : {}),
        mutations,
      };
    },
    catch: (error) =>
      error instanceof PiSessionsError
        ? error
        : new PiSessionsError({
            kind: "invalid",
            message: `${path}: ${error instanceof Error ? error.message : String(error)}`,
            cause: error,
          }),
  });

/** The promise FileSystem seam pi's repo needs, over the effect FileSystem
 * service (the same adapter shape as LocalEnv). Failures are conduits for
 * the repo's own error reporting — the errno taxonomy is not needed here. */
const jsonlFsOf = (fs: FileSystem.FileSystem): JsonlSessionRepoFileSystem => {
  const fail = (path: string, error: unknown) =>
    new FileError(
      "unknown",
      `filesystem error: ${error instanceof Error ? error.message : String(error)}`,
      path,
    );
  const run = <T>(effect: Effect.Effect<T, unknown, never>): Promise<PiResult<T, FileError>> =>
    Effect.runPromise(effect.pipe(Effect.result)).then((outcome): PiResult<T, FileError> =>
      Result.isSuccess(outcome) ? ok(outcome.success) : err(fail("", outcome.failure)),
    );
  return {
    absolutePath: (path) => run(Effect.succeed(resolve(path))),
    joinPath: (parts) => run(Effect.succeed(parts.join("/"))),
    readTextFile: (path) => run(fs.readFileString(path)),
    writeFile: (path, content) =>
      Effect.runPromise(
        fs
          .writeFileString(
            path,
            typeof content === "string" ? content : Buffer.from(content).toString(),
          )
          .pipe(Effect.result),
      ).then((outcome) =>
        Result.isSuccess(outcome) ? ok(undefined) : err(fail(path, outcome.failure)),
      ),
    appendFile: (path, content) =>
      Effect.runPromise(
        fs
          .writeFileString(
            path,
            typeof content === "string" ? content : Buffer.from(content).toString(),
            { flag: "a" },
          )
          .pipe(Effect.result),
      ).then((outcome) =>
        Result.isSuccess(outcome) ? ok(undefined) : err(fail(path, outcome.failure)),
      ),
    renameFile: (sourcePath, destinationPath) =>
      Effect.runPromise(fs.rename(sourcePath, destinationPath).pipe(Effect.result)).then(
        (outcome) =>
          Result.isSuccess(outcome) ? ok(undefined) : err(fail(sourcePath, outcome.failure)),
      ),
    fileInfo: (path) =>
      Effect.runPromise(
        fs.stat(path).pipe(
          Effect.map((info) => ({
            name: path.split("/").pop() ?? path,
            path,
            kind: info.type === "Directory" ? ("directory" as const) : ("file" as const),
            size: Number(info.size),
            mtimeMs: Option.isSome(info.mtime) ? info.mtime.value.getTime() : 0,
          })),
          Effect.result,
        ),
      ).then((outcome) =>
        Result.isSuccess(outcome) ? ok(outcome.success) : err(fail(path, outcome.failure)),
      ),
    listDir: (path) =>
      Effect.runPromise(fs.readDirectory(path).pipe(Effect.result)).then(
        (outcome) =>
          Result.isSuccess(outcome)
            ? ok(
                outcome.success.map((name) => ({
                  name,
                  path: `${path}/${name}`,
                  kind: "file" as const,
                  size: 0,
                  mtimeMs: 0,
                })),
              )
            : err(fail(path, outcome.failure)),
      ),
    exists: (path) =>
      Effect.runPromise(fs.exists(path).pipe(Effect.result)).then(
        (outcome) =>
          Result.isSuccess(outcome) ? ok(outcome.success) : err(fail(path, outcome.failure)),
      ),
    createDir: (path, options) =>
      Effect.runPromise(
        fs.makeDirectory(path, { recursive: options?.recursive ?? true }).pipe(Effect.result),
      ).then((outcome) =>
        Result.isSuccess(outcome) ? ok(undefined) : err(fail(path, outcome.failure)),
      ),
    remove: (path, options) =>
      Effect.runPromise(
        fs
          .remove(path, {
            recursive: options?.recursive ?? false,
            force: options?.force ?? false,
          })
          .pipe(Effect.result),
      ).then((outcome) =>
        Result.isSuccess(outcome) ? ok(undefined) : err(fail(path, outcome.failure)),
      ),
  };
};

/** v4 log items are the same mutation vocabulary with seq hoisted and lane
 * dropped from entries — normalize to saku's SessionMutation. */
const logItemToMutation = (item: {
  readonly kind: string;
  readonly seq: number;
  [key: string]: unknown;
}): SessionMutation => {
  if (item.kind === "entry") {
    return { kind: "entry", entry: item.entry as Entry };
  }
  if (item.kind === "record") {
    return { kind: "record", record: item.record as never };
  }
  return item as unknown as SessionMutation;
};

/** The cheap list view of a v4 file (the header line is already decoded). */
const scanV4Lines = (
  header: Record<string, unknown>,
  lines: readonly string[],
) => {
  if (typeof header.id !== "string" || typeof header.cwd !== "string") return undefined;
  let name: string | undefined;
  let messageCount = 0;
  let firstMessage = "";
  for (let index = 1; index < lines.length; index++) {
    const obj = parseLine(lines[index] ?? "");
    if (obj === undefined) continue;
    if (obj.kind === "fact" && obj.fact === "name" && typeof obj.name === "string") {
      const trimmed = obj.name.trim();
      if (trimmed.length > 0) name = trimmed;
      else name = undefined;
    } else if (obj.kind === "entry" && obj.type === "message") {
      messageCount += 1;
      if (firstMessage.length === 0) firstMessage = firstMessageOf(obj) ?? "";
    }
  }
  return {
    id: header.id,
    cwd: header.cwd,
    ...(name === undefined ? {} : { name }),
    createdAt: toEpochMs(header.createdAt),
    messageCount,
    firstMessage: firstMessage.length > 0 ? firstMessage : "(no messages)",
  };
};

/** Scan one session file into its summary; Option.none when it is not a
 * readable pi session (pi's own list skips those silently). */
const scanFile = Effect.fn("scanFile")(function* (fs: FileSystem.FileSystem, path: string) {
  const content = yield* fs.readFileString(path).pipe(Effect.catch(() => Effect.succeed("")));
  if (content.length === 0) return Option.none();
  const lines = content.split("\n");
  const first = parseLine(lines[0] ?? "");
  if (first === undefined) return Option.none();
  const summary =
    first.type === "session"
      ? scanV3Lines(path, lines)
      : first.kind === "header" && first.version === 4
        ? scanV4Lines(first, lines)
        : undefined;
  if (summary === undefined) return Option.none();
  const stat = yield* fs.stat(path).pipe(Effect.catch(() => Effect.succeed(undefined)));
  return Option.some({
    ...summary,
    modifiedAt:
      stat !== undefined && Option.isSome(stat.mtime)
        ? stat.mtime.value.getTime()
        : summary.createdAt,
    path,
  });
});

/** List every readable pi session under the sessions root, newest first. */
export const listPiSessions = Effect.fn("listPiSessions")(function* (
  fs: FileSystem.FileSystem,
  paths: PathsShape,
): Effect.fn.Return<readonly PiSessionSummary[], PiSessionsError, never> {
  const root = sessionsRootOf(paths);
  const dirs = yield* fs
    .readDirectory(root)
    .pipe(Effect.catch(() => Effect.succeed([] as string[])));
  const files: string[] = [];
  for (const dir of dirs) {
    const entries = yield* fs
      .readDirectory(`${root}/${dir}`)
      .pipe(Effect.catch(() => Effect.succeed([] as string[])));
    for (const entry of entries) {
      if (entry.endsWith(".jsonl")) files.push(`${root}/${dir}/${entry}`);
    }
  }
  const scanned = yield* Effect.forEach(files, (path) => scanFile(fs, path), {
    concurrency: 10,
  });
  return scanned
    .filter((entry): entry is Option.Some<PiSessionSummary> => Option.isSome(entry))
    .map((entry) => entry.value)
    .sort((a, b) => b.modifiedAt - a.modifiedAt);
});

/** Parse one pi session file for adoption (v3 natively, v4 via pi's repo). */
export const readPiSession = Effect.fn("readPiSession")(function* (
  fs: FileSystem.FileSystem,
  paths: PathsShape,
  path: string,
) {
  const content = yield* fs.readFileString(path).pipe(
    Effect.mapError(
      (error) =>
        new PiSessionsError({
          kind: "not_found",
          message: `cannot read pi session ${path}: ${error instanceof Error ? error.message : String(error)}`,
          cause: error,
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
    if (Result.isFailure(outcome)) return yield* Effect.fail(outcome.failure);
    return outcome.success;
  }
  if (first.kind === "header" && first.version === 4) {
    return yield* readV4(fs, paths, path, first);
  }
  return yield* Effect.fail(
    new PiSessionsError({ kind: "invalid", message: `${path}: not a pi session file` }),
  );
});

/** Adopt a v4 file through pi-agent-core's own repo (its codec, its repair). */
const readV4 = (
  fs: FileSystem.FileSystem,
  paths: PathsShape,
  path: string,
  header: Record<string, unknown>,
) =>
  Effect.tryPromise({
    try: async () => {
      // The header is already decoded here; build the metadata directly —
      // the repo's own list() would throw on the v3 files that share the
      // sessions root (its codec is v4-only).
      const metadata: JsonlSessionMetadata = {
        id: header.id as string,
        createdAt: toEpochMs(header.createdAt),
        cwd: header.cwd as string,
        path,
        modifiedAt: Date.now(),
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
        mutations.push({ kind: "lane", seq: ++seq, lane: pointer.lane, leafId: pointer.leafId });
      }
      let name: string | undefined;
      let firstMessage = "";
      for (const item of log) {
        if (item.kind === "fact" && item.fact === "name" && typeof item.name === "string") {
          name = item.name;
        } else if (
          item.kind === "entry" &&
          item.entry.type === "message" &&
          firstMessage.length === 0
        ) {
          const message = item.entry.message;
          if (message !== undefined && (message.role === "user" || message.role === "assistant")) {
            firstMessage = textContent(message.content);
          }
        }
      }
      return {
        id: metadata.id,
        cwd: metadata.cwd,
        createdAt: metadata.createdAt,
        ...(name === undefined || name.length === 0 ? {} : { name }),
        ...(firstMessage.length > 0 ? { firstMessage } : {}),
        mutations,
      };
    },
    catch: (error) =>
      error instanceof PiSessionsError
        ? error
        : new PiSessionsError({
            kind: "invalid",
            message: `invalid pi session ${path}: ${error instanceof Error ? error.message : String(error)}`,
            cause: error,
          }),
  });
