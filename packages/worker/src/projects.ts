/**
 * Projects (projects.ts): the local daemon's added-project list
 * (CONTEXT.md: Project) — the explicit cwds whose pi sessions the session
 * window lists. Daemon-local by design: a project exists only to scope the
 * pi-session window, and that window is local-daemon-only (the hub has no
 * `~/.pi`, so it answers `projects_not_served` like `list_pi_sessions`).
 *
 * The list is one JSON document (`projects.json` under the saku home),
 * written through the KvStore seam — the same atomic tmp+rename boundary
 * the registry and thread trails cross. A project is a resolved absolute
 * path; adding is idempotent (re-adding an existing path is a no-op),
 * removing is a no-op when absent, and removing never touches threads — a
 * thread carries its own cwd and provenance (adopted threads are threads
 * now).
 */

import { resolve } from "node:path";
import { Effect, FileSystem, Option, Schema } from "effect";

import { KvStore, type KvStoreShape } from "@saku/store";
import type { PathsShape } from "./paths.ts";

/** One added project: the resolved absolute cwd and when it was added. */
export const ProjectRecordSchema = Schema.Struct({
  path: Schema.String,
  addedAt: Schema.Number,
});
export type ProjectRecord = Schema.Schema.Type<typeof ProjectRecordSchema>;

/** The persisted document: the list itself (one key, one JSON object). */
const ProjectsDocSchema = Schema.Struct({
  projects: Schema.Array(ProjectRecordSchema),
});

const DOC_KEY = "projects.json";

const decodeDoc = Schema.decodeUnknownSync(ProjectsDocSchema);

/** The store's view of the document: missing OR corrupt reads as empty. */
const readDoc = (kv: KvStoreShape) =>
  kv.get(DOC_KEY).pipe(
    Effect.flatMap((bytes) =>
      Option.match(bytes, {
        onNone: () => Effect.succeed({ projects: [] as readonly ProjectRecord[] }),
        onSome: (value) =>
          Effect.try({
            try: () => JSON.parse(new TextDecoder().decode(value)) as unknown,
            catch: (error) => error,
          })
            .pipe(
              Effect.flatMap((parsed) => Effect.sync(() => decodeDoc(parsed))),
              Effect.catch(() => Effect.succeed({ projects: [] as readonly ProjectRecord[] })),
            ),
      }),
    ),
  );

const writeDoc = (kv: KvStoreShape, projects: readonly ProjectRecord[]) =>
  kv.put(DOC_KEY, new TextEncoder().encode(`${JSON.stringify({ projects })}\n`));

/** Run a store effect over the file backend rooted at the saku home. */
const withStore = <A, E>(
  fs: FileSystem.FileSystem,
  paths: PathsShape,
  effect: Effect.Effect<A, E, KvStore>,
) => effect.pipe(Effect.provide(KvStore.file(fs, paths.sakuDir)));

/** The added projects, oldest first. */
export const listProjects = Effect.fn("listProjects")(function* (
  fs: FileSystem.FileSystem,
  paths: PathsShape,
): Effect.fn.Return<readonly ProjectRecord[], never, never> {
  const doc = yield* withStore(fs, paths, Effect.gen(function* () {
    const kv = yield* KvStore;
    return yield* readDoc(kv);
  }));
  return [...doc.projects].sort((a, b) => a.addedAt - b.addedAt);
});

/** Add a project: the path is resolved (absolute), re-adding is a no-op. */
export const addProject = Effect.fn("addProject")(function* (
  fs: FileSystem.FileSystem,
  paths: PathsShape,
  input: string,
): Effect.fn.Return<ProjectRecord, never, never> {
  const path = resolve(input);
  return yield* withStore(fs, paths, Effect.gen(function* () {
    const kv = yield* KvStore;
    const doc = yield* readDoc(kv);
    const existing = doc.projects.find((project) => project.path === path);
    if (existing !== undefined) return existing;
    const project: ProjectRecord = { path, addedAt: Date.now() };
    yield* writeDoc(kv, [...doc.projects, project]);
    return project;
  }));
});

/** Remove a project from the window; a no-op when it was never added. */
export const removeProject = Effect.fn("removeProject")(function* (
  fs: FileSystem.FileSystem,
  paths: PathsShape,
  input: string,
): Effect.fn.Return<void, never, never> {
  const path = resolve(input);
  yield* withStore(fs, paths, Effect.gen(function* () {
    const kv = yield* KvStore;
    const doc = yield* readDoc(kv);
    const remaining = doc.projects.filter((project) => project.path !== path);
    if (remaining.length === doc.projects.length) return;
    yield* writeDoc(kv, remaining);
  }));
});
