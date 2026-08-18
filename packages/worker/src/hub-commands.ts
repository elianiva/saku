/**
 * The hub-command dispatch (hub-commands.ts): the daemon's single map from
 * wire hub commands (threads, skills, pi sessions, projects) to the
 * registry/projects calls behind them — the hub-level sibling of the
 * session-command dispatch (`session-commands.ts`), with which it shares
 * the resolution seam (`resolveThreadId`), the broadcast seam
 * (`emitThreadChanged`), and the host cache (`HostCacheApi`).
 *
 * The dispatch is parameterized by its deps, so it stays transport-free:
 * the daemon provides the file-backed registry, the lazy hosts, and the
 * wire core's fan-out. Skills are deliberately not served here
 * (`skills_not_served`, ADR 0007 — the hub hosts the skills store); pi
 * sessions and projects are daemon-local (the hub answers
 * `projects_not_served`).
 */

import { Effect, Match, Option, Result } from "effect";
import type { FileSystem } from "effect";
import nodePath from "node:path";

import {
  AddProjectResponse,
  ArchiveThreadResponse,
  BrowseProjectDirsResponse,
  CreateThreadResponse,
  DeleteThreadResponse,
  GetThreadResponse,
  ImportPiSessionResponse,
  ListPiSessionsResponse,
  ListThreadsResponse,
  ProjectResponse,
  RemoveProjectResponse,
  RenameThreadResponse,
  UnarchiveThreadResponse,
  shortThreadId,
} from "@saku/wire";
import type {
  PiSessionCommand,
  ProjectCommand,
  ResponsePayload,
  SkillCommand,
  ThreadCommand,
  ThreadInfo,
  ThreadMode,
} from "@saku/wire";
import { KvStore } from "@saku/store";

import { DaemonError } from "./daemon-error.ts";
import type { HostCacheApi } from "./host-cache.ts";
import type { PathsLayout } from "./paths.ts";
import type { ThreadRegistryApi } from "./registry.ts";
import type { SessionHostError } from "./session-host.ts";
import { DoSessionRepo } from "./do-session-repo.ts";
import { browseProjectDirs, listPiSessions, readPiSession } from "./pi-sessions/index.ts";
import type { PiSessionData } from "./pi-sessions/index.ts";
import { addProject, listProjects, removeProject } from "./projects.ts";

/** The wire command union the daemon routes (the four command families). */
export type HubCommand = ThreadCommand | SkillCommand | PiSessionCommand | ProjectCommand;

/** The hub command with the given wire tag. */
type HubCommandOf<Tag extends HubCommand["_tag"]> = Extract<HubCommand, { readonly _tag: Tag }>;

/** The failures a wire command handler can produce. */
export type CommandError = DaemonError | SessionHostError;

/** The seam the dispatch runs on (the daemon's composition of services). */
export interface HubCommandDeps {
  readonly fs: FileSystem.FileSystem;
  readonly paths: PathsLayout;
  readonly registry: ThreadRegistryApi;
  readonly hostCache: HostCacheApi;
  /** Resolve a user-supplied thread id/name/prefix against the registry. */
  readonly resolveThreadId: (input: string) => Effect.Effect<string, DaemonError>;
  /** Fan a thread_changed out to every console (the wire core's broadcast). */
  readonly emitThreadChanged: (thread: ThreadInfo) => Effect.Effect<void>;
}

/** The skills store is hub-hosted (ADR 0007); the local daemon deliberately
 * does not implement it. */
const skillsNotServed = () =>
  Effect.fail(
    new DaemonError({
      code: "skills_not_served",
      message: "skills are served by the hub, not the local daemon",
    }),
  );

/** The create-thread fields the registry accepts (registry.ts's input contract). */
interface CreateThreadInput {
  autoName?: boolean;
  cwd?: string;
  mode?: ThreadMode;
  name: string;
}

/** The adopted thread's default name: the session name, the first message,
 * the cwd's last segment, or a fixed fallback (pi's own list semantics). */
const importNameOf = (session: PiSessionData) => {
  if (session.name !== undefined) {
    return session.name;
  }
  const first = session.firstMessage;
  if (first !== undefined && first !== "(no messages)") {
    return first.length > 80 ? `${first.slice(0, 80)}…` : first;
  }
  const fromCwd = session.cwd.split("/").findLast(Boolean);
  return fromCwd ?? "pi session";
};

/**
 * One wire hub command → the registry/projects calls behind it. Failures
 * flow as `CommandError` (DaemonError from the registry/resolution seam,
 * SessionHostError from the host cache); the caller owns the frame.
 */
export const runHubCommand = (deps: HubCommandDeps, hubCommand: HubCommand) =>
  Match.value(hubCommand).pipe(
    Match.withReturnType<Effect.Effect<ResponsePayload, CommandError>>(),
    Match.tagsExhaustive({
      add_project: Effect.fn("add_project")(function* (command: HubCommandOf<"add_project">) {
        const project = yield* addProject(deps.fs, deps.paths, command.path);
        return AddProjectResponse.make({ project });
      }),
      archive_thread: Effect.fn("archive_thread")(function* (
        command: HubCommandOf<"archive_thread">,
      ) {
        // Archive is visibility-only (CONTEXT.md: Archive): the trail,
        // session, and env are untouched; unarchive is always possible.
        const threadId = yield* deps.resolveThreadId(command.threadId);
        const archived = yield* deps.registry.archive(threadId);
        if (Option.isNone(archived)) {
          return yield* Effect.fail(
            new DaemonError({
              code: "unknown_thread",
              message: `unknown thread: ${command.threadId}`,
            }),
          );
        }
        const info = yield* deps.hostCache.infoOf(threadId);
        yield* deps.emitThreadChanged(info);
        return ArchiveThreadResponse.make({ thread: info });
      }),
      browse_project_dirs: Effect.fn("browse_project_dirs")(function* (
        command: HubCommandOf<"browse_project_dirs">,
      ) {
        // One level of the add-project tree (CONTEXT.md: Add project):
        // the subdirectories of the requested path, candidates marked.
        const browse = yield* browseProjectDirs(deps.fs, deps.paths, command.path).pipe(
          Effect.mapError(
            (error) =>
              new DaemonError({
                cause: error,
                code: "pi_sessions",
                message: error.message,
              }),
          ),
        );
        return BrowseProjectDirsResponse.make(browse);
      }),
      create_thread: Effect.fn("create_thread")(function* (command: HubCommandOf<"create_thread">) {
        const createOptions: CreateThreadInput = { name: command.name };
        if (command.cwd !== undefined) {
          createOptions.cwd = command.cwd;
        }
        if (command.mode !== undefined) {
          createOptions.mode = command.mode;
        }
        if (command.autoName !== undefined) {
          createOptions.autoName = command.autoName;
        }
        const record = yield* deps.registry.create(createOptions);
        const info = yield* deps.hostCache.infoOf(record.id);
        yield* deps.emitThreadChanged(info);
        return CreateThreadResponse.make({ thread: info });
      }),
      delete_skill: skillsNotServed,
      delete_thread: Effect.fn("delete_thread")(function* (command: HubCommandOf<"delete_thread">) {
        const threadId = yield* deps.resolveThreadId(command.threadId);
        // Capture the info before the record is removed — the broadcast
        // tells every console the thread is gone.
        const info = yield* deps.hostCache.infoOf(threadId);
        yield* deps.hostCache.disposeHost(threadId);
        yield* deps.registry.delete(threadId);
        yield* deps.emitThreadChanged(info);
        return DeleteThreadResponse.make({});
      }),
      get_thread: Effect.fn("get_thread")(function* (command: HubCommandOf<"get_thread">) {
        const threadId = yield* deps.resolveThreadId(command.threadId);
        const info = yield* deps.hostCache.infoOf(threadId);
        return GetThreadResponse.make({ thread: info });
      }),
      import_pi_session: Effect.fn("import_pi_session")(function* (
        command: HubCommandOf<"import_pi_session">,
      ) {
        // Adoption is idempotent per pi session file: one thread per
        // source (the record's provenance field is the key).
        const records = yield* deps.registry.list();
        const adopted = records.find(
          (record) => record.source?.kind === "pi" && record.source.path === command.path,
        );
        if (adopted !== undefined) {
          return yield* Effect.fail(
            new DaemonError({
              code: "already_imported",
              message: `already imported as ${shortThreadId(adopted.id)} (${adopted.name})`,
            }),
          );
        }
        const session = yield* readPiSession(deps.fs, deps.paths, command.path).pipe(
          Effect.mapError(
            (error) =>
              new DaemonError({
                cause: error,
                code: "pi_sessions",
                message: error.message,
              }),
          ),
        );
        const name = importNameOf(session);
        const record = yield* deps.registry.create({
          cwd: session.cwd,
          mode: "local",
          name,
          source: { kind: "pi", path: command.path, sessionId: session.id },
        });
        // Adopt the trail: replay the pi mutations into the thread's own
        // kv store, then back-fill the session id. A failure rolls the
        // record back — an import must be all-or-nothing.
        const importOutcome = yield* Effect.gen(function* () {
          const kv = yield* KvStore;
          return yield* Effect.tryPromise({
            catch: (error) =>
              new DaemonError({
                cause: error,
                code: "pi_sessions",
                message: `failed to import ${command.path}: ${error instanceof Error ? error.message : String(error)}`,
              }),
            try: async () =>
              await new DoSessionRepo(kv).import(record.id, {
                createdAt: session.createdAt,
                cwd: session.cwd,
                mutations: session.mutations,
              }),
          });
        })
          .pipe(Effect.provide(KvStore.file(deps.fs, deps.paths.threadTrailRoot(record.id))))
          .pipe(Effect.result);
        if (Result.isFailure(importOutcome)) {
          yield* deps.registry.delete(record.id);
          return yield* Effect.fail(importOutcome.failure);
        }
        yield* deps.registry.update(record.id, { sessionId: record.id });
        const info = yield* deps.hostCache.infoOf(record.id);
        yield* deps.emitThreadChanged(info);
        return ImportPiSessionResponse.make({ thread: info });
      }),
      import_skill: skillsNotServed,
      list_pi_sessions: Effect.fn("list_pi_sessions")(function* (
        command: HubCommandOf<"list_pi_sessions">,
      ) {
        // pi's session files live on the user's machine; only the local
        // daemon can read them (the mirror of skills_not_served). The
        // list is the window's scope (CONTEXT.md: Project): a filter
        // arg scopes to one project, otherwise every added project.
        // Unreadable dirs read as empty (pi's own list skips those
        // silently); failures surface as DaemonError(pi_sessions).
        const projects =
          command.project === undefined
            ? (yield* listProjects(deps.fs, deps.paths)).map((project) => project.path)
            : [nodePath.resolve(command.project)];
        const sessions = yield* listPiSessions(deps.fs, deps.paths, projects);
        return ListPiSessionsResponse.make({ sessions });
      }),
      list_projects: Effect.fn("list_projects")(function* () {
        const projects = yield* listProjects(deps.fs, deps.paths);
        return ProjectResponse.make({ _tag: "list_projects", projects });
      }),
      list_skills: skillsNotServed,
      list_threads: Effect.fn("list_threads")(function* () {
        const records = yield* deps.registry.list();
        const threads = yield* Effect.forEach(
          records,
          (record) => deps.hostCache.infoOf(record.id),
          {
            concurrency: "unbounded",
          },
        );
        return ListThreadsResponse.make({ threads });
      }),
      remove_project: Effect.fn("remove_project")(function* (
        command: HubCommandOf<"remove_project">,
      ) {
        yield* removeProject(deps.fs, deps.paths, command.path);
        return RemoveProjectResponse.make({});
      }),
      rename_thread: Effect.fn("rename_thread")(function* (command: HubCommandOf<"rename_thread">) {
        const threadId = yield* deps.resolveThreadId(command.threadId);
        const name = command.name.trim();
        if (name.length === 0) {
          return yield* Effect.fail(
            new DaemonError({ code: "empty_name", message: "name must not be empty" }),
          );
        }
        // A user rename wins over auto-title forever (CONTEXT.md: Auto-title).
        yield* deps.registry.update(threadId, { name, nameAuto: false });
        const info = yield* deps.hostCache.infoOf(threadId);
        yield* deps.emitThreadChanged(info);
        return RenameThreadResponse.make({ thread: info });
      }),
      unarchive_thread: Effect.fn("unarchive_thread")(function* (
        command: HubCommandOf<"unarchive_thread">,
      ) {
        const threadId = yield* deps.resolveThreadId(command.threadId);
        const unarchived = yield* deps.registry.unarchive(threadId);
        if (Option.isNone(unarchived)) {
          return yield* Effect.fail(
            new DaemonError({
              code: "unknown_thread",
              message: `unknown thread: ${command.threadId}`,
            }),
          );
        }
        const info = yield* deps.hostCache.infoOf(threadId);
        yield* deps.emitThreadChanged(info);
        return UnarchiveThreadResponse.make({ thread: info });
      }),
    }),
  );
