/**
 * The projects store round-trip (projects.test.ts): add → list → remove
 * over the real Node filesystem in a temp home (`PathsTest`). The store is
 * daemon-local (CONTEXT.md: Project) — one JSON document under the saku
 * home — so these tests pin a home and reuse it across boots, exactly like
 * the registry's disk round-trip tests.
 */

import { tmpdir } from "node:os";
import path from "node:path";

import { NodeFileSystem } from "@effect/platform-node";
import { Effect, FileSystem } from "effect";
import { describe, expect, it } from "vitest";

import { Paths, PathsTest } from "../src/paths.ts";
import type { PathsLayout } from "../src/paths.ts";
import { addProject, listProjects, removeProject } from "../src/projects.ts";

/** Resolve the fs + paths services against a pinned temp home (the caller
 *  owns the home's lifecycle), then run the body with them as arguments. */
const makeTempDir = (prefix: string) =>
  Effect.provide(NodeFileSystem.layer)(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.makeTempDirectory({ directory: tmpdir(), prefix });
    }),
  );

const removeDir = (dir: string) =>
  Effect.provide(NodeFileSystem.layer)(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(dir, { force: true, recursive: true });
    }).pipe(Effect.catch(() => Effect.void)),
  );

const runStore = async <A, E>(
  body: (fs: FileSystem.FileSystem, paths: PathsLayout) => Effect.Effect<A, E>,
  home: string,
) =>
  await Effect.runPromise(
    Effect.provide(NodeFileSystem.layer)(
      Effect.provide(PathsTest(home))(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const paths = yield* Paths;
          const outcome = yield* body(fs, paths);
          return outcome;
        }),
      ),
    ),
  );

describe("projects store", () => {
  it("adds, lists, and removes projects across boots", async () => {
    const home = await Effect.runPromise(makeTempDir("saku-projects-"));
    try {
      const first = await runStore((fs, paths) => addProject(fs, paths, "/tmp/work"), home);
      expect(first.path).toBe("/tmp/work");
      expect(first.addedAt).toBeGreaterThan(0);

      // A second boot sees the persisted project.
      const listed = await runStore((fs, paths) => listProjects(fs, paths), home);
      expect(listed.map((p) => p.path)).toEqual(["/tmp/work"]);

      // Re-adding is a no-op (same record, still one entry).
      const again = await runStore((fs, paths) => addProject(fs, paths, "/tmp/work"), home);
      expect(again.path).toBe("/tmp/work");
      const afterAgain = await runStore((fs, paths) => listProjects(fs, paths), home);
      expect(afterAgain).toHaveLength(1);

      // Remove is window-only and persists.
      await runStore((fs, paths) => removeProject(fs, paths, "/tmp/work"), home);
      const afterRemove = await runStore((fs, paths) => listProjects(fs, paths), home);
      expect(afterRemove).toHaveLength(0);

      // Removing an absent project is a no-op, not an error.
      await runStore((fs, paths) => removeProject(fs, paths, "/never/added"), home);
    } finally {
      await Effect.runPromise(removeDir(home));
    }
  });

  it("resolves relative paths to absolute", async () => {
    const home = await Effect.runPromise(makeTempDir("saku-projects-rel-"));
    try {
      const project = await runStore((fs, paths) => addProject(fs, paths, "relative/dir"), home);
      expect(project.path.startsWith("/")).toBe(true);
      expect(project.path.endsWith("/relative/dir")).toBe(true);
    } finally {
      await Effect.runPromise(removeDir(home));
    }
  });

  it("a missing or corrupt document reads as an empty list", async () => {
    const home = await Effect.runPromise(makeTempDir("saku-projects-empty-"));
    try {
      const empty = await runStore((fs, paths) => listProjects(fs, paths), home);
      expect(empty).toHaveLength(0);

      // Corrupt the document, then read: still an empty list.
      await runStore(
        (fs, paths) =>
          fs.writeFileString(paths.projectsPath, "not json at all").pipe(Effect.asVoid),
        home,
      );
      const afterCorrupt = await runStore((fs, paths) => listProjects(fs, paths), home);
      expect(afterCorrupt).toHaveLength(0);
    } finally {
      await Effect.runPromise(removeDir(home));
    }
  });
});
