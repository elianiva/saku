/**
 * The pi-sessions window (pi-sessions/index.ts): the local daemon's view
 * of pi's own session files — `~/.pi/agent/sessions/**` (the layout's
 * `agentDir`, honoring `PI_CODING_AGENT_DIR`) — listed, browsed, and
 * adopted as saku threads.
 *
 * Listing is scoped to the added projects (CONTEXT.md: Project): only
 * their session dirs are read (dir-name prefix match — zero file reads
 * for anything else), and every listed session's header cwd is verified
 * to sit under a project, so pi's lossy dir encoding can never
 * misattribute a session. An empty project list is an empty window —
 * nothing is scanned.
 *
 * Import is adoption: the mutations are replayed into the thread's own
 * trail (`DoSessionRepo.import`), and the pi file is never written. A
 * broken parent chain or duplicate id fails the import with the offending
 * line — better than a thread that breaks on first touch.
 *
 * The two on-disk formats are read by the format readers — pi-sessions/v3.ts
 * (pi's shell: type-keyed lines, no seq/lane) and pi-sessions/v4.ts
 * (pi-agent-core's jsonl: kind/seq/lane mutations) — and the add-project
 * tree is pi-sessions/browse.ts; this module owns the shared vocabulary
 * (pi-sessions/common.ts) and the window-level orchestration: scanning a
 * file (cheap list view), listing the window, and parsing for adoption.
 */

import nodePath from "node:path";
import { Effect, Option, Result } from "effect";
import type { FileSystem } from "effect";

import type { PathsLayout } from "../paths.ts";
import {
  isV4Header,
  parseLine,
  parseV3Header,
  sessionDirNameOf,
  sessionsRootOf,
  PiSessionsError,
} from "./common.ts";
import type { PiSessionSummary, ScannedSession } from "./common.ts";
import { parseV3, scanV3Lines } from "./v3.ts";
import { readV4, scanV4Lines } from "./v4.ts";

export { browseProjectDirs } from "./browse.ts";
export { PiSessionsError, sessionDirNameOf } from "./common.ts";
export type { PiSessionData, PiSessionSummary } from "./common.ts";

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

/** Scan one session file into its summary; Option.none when it is not a
 * readable pi session (pi's own list skips those silently). */
const scanFile = Effect.fn("scanFile")(function* (fs: FileSystem.FileSystem, path: string) {
  const content = yield* fs.readFileString(path).pipe(Effect.catch(() => Effect.succeed("")));
  if (content.length === 0) {
    return Option.none();
  }
  const lines = content.split("\n");
  const first = parseLine(lines[0] ?? "");
  if (first === undefined) {
    return Option.none();
  }
  let summary: ScannedSession | undefined;
  const v3Header = parseV3Header(first);
  if (v3Header !== undefined) {
    summary = scanV3Lines(lines, v3Header);
  } else if (isV4Header(first)) {
    summary = scanV4Lines(lines, first);
  }
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

/**
 * List the pi sessions under the given projects, newest first. The projects
 * are the scope of the window (CONTEXT.md: Project): only their session
 * dirs are read (dir-name prefix match — zero file reads for anything
 * else), and every listed session's header cwd is verified to sit under a
 * project, so pi's lossy dir encoding can never misattribute a session.
 * An empty project list is an empty window — nothing is scanned.
 */
export const listPiSessions = Effect.fn("listPiSessions")(function* (
  fs: FileSystem.FileSystem,
  paths: PathsLayout,
  projects: readonly string[],
) {
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

/** Parse one pi session file for adoption (v3 natively, v4 via pi's repo). */
export const readPiSession = Effect.fn("readPiSession")(function* (
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
