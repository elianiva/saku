/**
 * The add-project picker tree (pi-sessions/browse.ts): the daemon serves
 * the tree one level at a time (CONTEXT.md: Add project) — the
 * subdirectories of the requested path, each marked with whether pi has
 * sessions for that exact cwd. The picker descends level by level; the
 * daemon never returns the whole tree, only the level asked for.
 *
 * The candidate cwds — every cwd pi has sessions for — are decoded lossily
 * from the session dir names (the encoding can't distinguish dashes from
 * separators: good enough for a picker, the added path is what the user
 * commits); the opening level is the deepest common ancestor of the
 * candidates so their projects (one or two levels down, badges visible)
 * show, or the home directory when pi has no sessions yet.
 */

import { homedir } from "node:os";
import nodePath from "node:path";
import { Effect } from "effect";
import type { FileSystem } from "effect";

import type { PathsLayout } from "../paths.ts";
import { PiSessionsError, sessionsRootOf } from "./common.ts";

/** The picker's candidate cwds: every cwd pi has sessions for, decoded
 *  lossily from the session dir names (the encoding can't distinguish
 *  dashes from separators — good enough for a picker; the added path is
 *  what the user commits). No file reads. */
const listProjectCandidates = Effect.fn("listProjectCandidates")(function* listProjectCandidates(
  fs: FileSystem.FileSystem,
  paths: PathsLayout,
) {
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
) {
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
