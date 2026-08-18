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

import nodePath from "node:path";
import type { FileSystem } from "effect";
import { Effect, Option, Schema } from "effect";

import { KvStore } from "@saku/store";
import type { KvStoreApi } from "@saku/store";
import type { PathsLayout } from "./paths.ts";

/** One added project: the resolved absolute cwd and when it was added. */
export const ProjectRecordSchema = Schema.Struct({
  addedAt: Schema.Number,
  path: Schema.String,
});
export type ProjectRecord = Schema.Schema.Type<typeof ProjectRecordSchema>;

/** The persisted document: the list itself (one key, one JSON object). */
const ProjectsDocSchema = Schema.Struct({
  projects: Schema.Array(ProjectRecordSchema),
});

const DOC_KEY = "projects.json";

/** The store's view of the document: missing OR corrupt reads as empty. */
const readDoc = (kv: KvStoreApi) =>
  kv.get(DOC_KEY).pipe(
    Effect.flatMap((bytes) =>
      Option.match(bytes, {
        onNone: () => Effect.succeed({ projects: [] }),
        onSome: (value) =>
          Effect.try({
            catch: (error) => error,
            try: () => {
              const parsed: unknown = JSON.parse(new TextDecoder().decode(value));
              return parsed;
            },
          }).pipe(
            Effect.flatMap((parsed) => Schema.decodeUnknownEffect(ProjectsDocSchema)(parsed)),
            Effect.catchEager(() => Effect.succeed({ projects: [] })),
          ),
      }),
    ),
  );

const writeDoc = (kv: KvStoreApi, projects: readonly ProjectRecord[]) =>
  kv.put(DOC_KEY, new TextEncoder().encode(`${JSON.stringify({ projects })}\n`));

/** Run a body against the projects KvStore — one root, provided at the boundary. */
const withProjectsKv = <A, E>(
  fs: FileSystem.FileSystem,
  paths: PathsLayout,
  body: (kv: KvStoreApi) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const kv = yield* KvStore;
    return yield* body(kv);
  }).pipe(Effect.provide(KvStore.file(fs, paths.sakuDir)));

/** The added projects, oldest first. */
export const listProjects = Effect.fn("listProjects")(function* (
  fs: FileSystem.FileSystem,
  paths: PathsLayout,
) {
  const doc = yield* withProjectsKv(fs, paths, readDoc);
  return [...doc.projects].toSorted((a, b) => a.addedAt - b.addedAt);
});

/** Add a project: the path is resolved (absolute), re-adding is a no-op. */
export const addProject = Effect.fn("addProject")(function* (
  fs: FileSystem.FileSystem,
  paths: PathsLayout,
  input: string,
) {
  const path = nodePath.resolve(input);
  return yield* withProjectsKv(fs, paths, (kv) =>
    Effect.gen(function* () {
      const doc = yield* readDoc(kv);
      const existing = doc.projects.find((project) => project.path === path);
      if (existing !== undefined) {
        return existing;
      }
      const project: ProjectRecord = { addedAt: Date.now(), path };
      yield* writeDoc(kv, [...doc.projects, project]);
      return project;
    }),
  );
});

/** Remove a project from the window; a no-op when it was never added. */
export const removeProject = Effect.fn("removeProject")(function* (
  fs: FileSystem.FileSystem,
  paths: PathsLayout,
  input: string,
) {
  const path = nodePath.resolve(input);
  yield* withProjectsKv(fs, paths, (kv) =>
    Effect.gen(function* () {
      const doc = yield* readDoc(kv);
      const remaining = doc.projects.filter((project) => project.path !== path);
      if (remaining.length === doc.projects.length) {
        return;
      }
      yield* writeDoc(kv, remaining);
    }),
  );
});
