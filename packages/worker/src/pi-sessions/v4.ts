/**
 * The v4 pi-session reader (pi-sessions/v4.ts). v4 is pi-agent-core's jsonl
 * format (kind/seq/lane mutations); it is adopted through pi's own
 * `JsonlSessionRepo` — its codec, its repair. The header line is decoded by
 * the window before this module is reached (the repo's own list() would
 * throw on the v3 files that share the sessions root — its codec is
 * v4-only).
 *
 * The log's items are the same mutation vocabulary with seq hoisted and
 * lane dropped from entries — normalized to saku's `SessionMutation`; the
 * lanes, which v4 encodes on entry lines but the log strips, are re-pinned
 * so continuation chains onto each lane's last message.
 */

import nodePath from "node:path";
import { Effect, Option, Result } from "effect";
import type { FileSystem } from "effect";
import { FileError, JsonlSessionRepo, err, ok } from "@earendil-works/pi-agent-core";
import type {
  AgentMessage,
  JsonlSessionMetadata,
  JsonlSessionRepoFileSystem,
  JsonlV4Header,
  LogItem,
  MessageEntry,
} from "@earendil-works/pi-agent-core";

import type { PathsLayout } from "../paths.ts";
import type { SessionMutation } from "../session-state.ts";
import type { ScannedSession } from "./common.ts";
import {
  isString,
  scanLines,
  sessionData,
  sessionsRootOf,
  textContent,
  toEpochMs,
  PiSessionsError,
} from "./common.ts";

/** The cheap list view of a v4 file (the header line is already decoded;
 * its createdAt is normalized like the v3 header's, defensively). */
export const scanV4Lines = (lines: readonly string[], header: JsonlV4Header): ScannedSession =>
  scanLines(
    lines,
    {
      isMessage: (obj) => obj.kind === "entry" && obj.type === "message",
      isName: (obj) => obj.kind === "fact" && obj.fact === "name",
      nameOf: (obj) => (isString(obj.name) ? obj.name : undefined),
    },
    { createdAt: toEpochMs(header.createdAt), cwd: header.cwd, id: header.id },
  );

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
  absolutePath: async (filePath) => ok(nodePath.resolve(filePath)),
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
  joinPath: async (parts) => ok(parts.join("/")),
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

/** Adopt a v4 file through pi-agent-core's own repo (its codec, its repair). */
export const readV4 = (
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
      const firstMessageEntry = log.find(
        (
          item,
        ): item is Extract<LogItem, { readonly kind: "entry" }> & {
          readonly entry: MessageEntry & {
            readonly message: Extract<AgentMessage, { role: "user" | "assistant" }>;
          };
        } =>
          item.kind === "entry" &&
          item.entry.type === "message" &&
          (item.entry.message.role === "user" || item.entry.message.role === "assistant"),
      );
      return sessionData(
        {
          createdAt: metadata.createdAt,
          cwd: metadata.cwd,
          id: metadata.id,
          mutations,
        },
        {
          firstMessage:
            firstMessageEntry === undefined
              ? ""
              : textContent(firstMessageEntry.entry.message.content),
          name,
        },
      );
    },
  });
