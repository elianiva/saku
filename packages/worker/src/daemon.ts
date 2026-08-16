/**
 * The daemon (daemon.ts): the worker's WebSocket server, provided as a
 * scoped resource layer (`SakuDaemonLive` — the daemon-entry process runs it
 * under `Effect.never` and interrupts the fiber to shut down).
 *
 * Serves the wire protocol (ADR 0004) over WebSocket on 127.0.0.1 (random
 * port), authenticates consoles by token, routes wire commands to the
 * registry or to per-thread session hosts, and fans session events out to
 * every connected console (stateless routing — no attach/detach). The URL is
 * published to `~/.saku/worker.url` (the CLI reads it to connect).
 *
 * This is the transitional local spine: the hub (ADR 0001) will own the
 * wire's server side in production; the daemon keeps the local stack alive
 * and speaks exactly the same protocol. Both implementations share the
 * transport-free connection core of `@saku/wire/server` (hello/version
 * auth, command routing, fan-out) and the session-command dispatch of
 * `./session-commands.ts` — the daemon contributes only the registry-based
 * hub commands, the lazy per-thread hosts, and the lifecycle.
 *
 * `SakuDaemon.make` builds the daemon inside an `Effect.gen` (the same shape
 * as `@effect/platform-node`'s `NodeSocketServer` factory): all state that
 * crosses the socket boundary lives in `Ref`s made with `Ref.make`, command
 * handlers are `Effect.gen` pipelines, and socket events are plain callbacks
 * that fork Effects into the runtime (the boundary lutra's worker layers
 * draw). The daemon is provided as the `SakuDaemon` service; the layer's
 * scope holds it open, and closing the scope runs the finalizer.
 */

import type { WebSocketServer } from "ws";
import { NodeFileSystem } from "@effect/platform-node";
import nodePath from "node:path";
import { Context, Effect, FileSystem, Match, Layer, Option, Ref, Result, Semaphore } from "effect";

import {
  AddProjectResponse,
  ArchiveThreadResponse,
  BrowseProjectDirsResponse,
  CreateThreadResponse,
  DeleteThreadResponse,
  EventFrame,
  GetThreadResponse,
  ImportPiSessionResponse,
  ListPiSessionsResponse,
  ListThreadsResponse,
  ProjectResponse,
  RemoveProjectResponse,
  RenameThreadResponse,
  ThreadChanged,
  UnarchiveThreadResponse,
  resolveThread,
  shortThreadId,
} from "@saku/wire";
import type {
  PiSessionCommand,
  ProjectCommand,
  ResponsePayload,
  SessionCommand as SessionCommandType,
  SessionWireEvent,
  SkillCommand,
  ThreadCommand,
  ThreadInfo,
  ThreadMode,
  ThreadState,
  WireEvent,
} from "@saku/wire";
import { listenWs, WireServer, wsUrlOf } from "@saku/wire/server";
import type { WireServerApi } from "@saku/wire/server";

import { ensureAuthToken, ensureSakuDirs } from "./auth.ts";
import { DaemonError } from "./daemon-error.ts";
import { Paths, PathsLive, PathsTest } from "./paths.ts";
import type { PathsLayout } from "./paths.ts";
import { KvStore } from "@saku/store";
import { LocalEnv } from "@saku/env";
import {
  ThreadRegistry,
  ThreadRegistryLive,
  ThreadRegistryTest,
  RegistryKvLive,
} from "./registry.ts";
import type { HostRegistryApi, ThreadRecord, ThreadRegistryApi } from "./registry.ts";
import type { RegistryError } from "./registry-error.ts";
import { ModelCatalog, ModelCatalogLive, ModelCatalogTest } from "./model-catalog.ts";
import type { ModelCatalogApi } from "./model-catalog.ts";
import { SessionHost, SessionHostError } from "./session-host.ts";
import { runSessionCommand } from "./session-commands.ts";
import { DoSessionRepo } from "./do-session-repo.ts";
import { browseProjectDirs, listPiSessions, readPiSession } from "./pi-sessions/index.ts";
import type { PiSessionData } from "./pi-sessions/index.ts";
import { addProject, listProjects, removeProject } from "./projects.ts";

export interface DaemonOptions {
  /** Override the URL file path (tests). Defaults to ~/.saku/worker.url. */
  urlPath?: string;
}

/** The failures a wire command handler can produce. */
type CommandError = DaemonError | RegistryError | SessionHostError;

/** The wire command union the daemon routes (the four command families). */
type HubCommand = ThreadCommand | SkillCommand | PiSessionCommand | ProjectCommand;

/** The hub command with the given wire tag. */
type HubCommandOf<Tag extends HubCommand["_tag"]> = Extract<HubCommand, { readonly _tag: Tag }>;

/** The daemon's log line (the process's stdout is the worker.log file). */
const log = (message: string) => Effect.logInfo(`[saku-worker] ${message}`);

/** The skills store is hub-hosted (ADR 0007); the local daemon deliberately
 * does not implement it. */
const skillsNotServed = () =>
  Effect.fail(
    new DaemonError({
      code: "skills_not_served",
      message: "skills are served by the hub, not the local daemon",
    }),
  );

/** The daemon's startup phase failures (dirs/token/listen), all tagged. */
const startup = (message: string) => (error: Error) =>
  new DaemonError({
    cause: error,
    code: "startup",
    message: `${message}: ${error.message}`,
  });

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

/** Whether a thread's pi session has ever been created (started). */
const sessionStarted = Effect.fn("sessionStarted")(function* sessionStarted(
  fs: FileSystem.FileSystem,
  paths: PathsLayout,
  record: Option.Option<ThreadRecord>,
  threadId: string,
) {
  if (Option.isSome(record) && record.value.sessionId !== null) {
    return true;
  }
  // The session's metadata key is written before any mutation (do-session.ts),
  // so its presence means the session was created.
  const metaPath = `${paths.threadTrailRoot(threadId)}/session/${threadId}/meta`;
  return yield* fs.exists(metaPath).pipe(Effect.catch(() => Effect.succeed(false)));
});

/** The daemon's service surface. */
export interface SakuDaemonApi {
  /** The ws:// URL the daemon listens on. */
  readonly url: string;
  /** Stop the daemon: drop clients, dispose hosts, close the server. */
  readonly close: () => Effect.Effect<void>;
}

/** The daemon's service surface: `SakuDaemon.make` builds one. */
export class SakuDaemon extends Context.Service<SakuDaemon, SakuDaemonApi>()("SakuDaemon", {
  make: Effect.fn("SakuDaemon.make")(function* make(options: {
    registry: ThreadRegistryApi;
    catalog: ModelCatalogApi;
    fs: FileSystem.FileSystem;
    paths: PathsLayout;
    urlPath: string;
  }) {
    // Build the daemon: refs first, then the handlers as closures over them,
    // then the startup sequence (dirs, token, listen). The daemon's log is the
    // process's stdout — the CLI spawns it with worker.log as stdout, so
    // console output IS the log file.
    const { registry, catalog, fs, paths, urlPath } = options;
    const hostsRef = yield* Ref.make<ReadonlyMap<string, SessionHost>>(new Map());
    const closedRef = yield* Ref.make(false);
    const serverRef = yield* Ref.make<Option.Option<WebSocketServer>>(Option.none());
    // Serializes host construction: two concurrent first-touch commands must
    // not build two live hosts for one thread.
    const hostSemaphore = yield* Semaphore.make(1);

    // The wire core is built after the handlers (they close over the fan-out
    // helpers), so the broadcast seam is a ref filled once the core exists.
    const broadcastRef = yield* Ref.make<(event: WireEvent) => Effect.Effect<void>>(
      () => Effect.void,
    );

    /** All consoles see every session event (stateless routing). */
    const emitSessionEvent = (threadId: string, event: SessionWireEvent) =>
      Ref.get(broadcastRef).pipe(
        Effect.flatMap((broadcast) => broadcast(EventFrame.make({ event, threadId }))),
      );

    const emitThreadChanged = (thread: ThreadInfo) =>
      Ref.get(broadcastRef).pipe(
        Effect.flatMap((broadcast) => broadcast(ThreadChanged.make({ thread }))),
      );

    const tailSeqOf = (threadId: string) =>
      Ref.get(hostsRef).pipe(
        Effect.flatMap((hosts) => {
          const host = hosts.get(threadId);
          if (host === undefined) {
            return Effect.succeed(0);
          }
          return host.getEntries().pipe(Effect.map(({ tailSeq }) => tailSeq));
        }),
      );

    const infoOf = Effect.fn("infoOf")(function* infoOf(threadId: string) {
      const tailSeq = yield* tailSeqOf(threadId);
      const info = yield* registry.toInfo(threadId, tailSeq);
      if (Option.isNone(info)) {
        return yield* Effect.fail(
          new DaemonError({ code: "unknown_thread", message: `unknown thread: ${threadId}` }),
        );
      }
      return info.value;
    });

    /** Resolve a user-supplied thread id/name/prefix against the registry. */
    const resolveThreadId = Effect.fn("resolveThreadId")(function* resolveThreadId(input: string) {
      const threads = yield* registry.list();
      const resolved = resolveThread(threads, input);
      if (Result.isFailure(resolved)) {
        return yield* Effect.fail(
          new DaemonError({ code: "resolution", message: resolved.failure }),
        );
      }
      return resolved.success.id;
    });

    const runHubCommand = Effect.fn("runHubCommand")(function* runHubCommand(
      hubCommand: HubCommand,
    ) {
      return yield* Match.value(hubCommand).pipe(
        Match.withReturnType<Effect.Effect<ResponsePayload, CommandError>>(),
        Match.tagsExhaustive({
          add_project: Effect.fn("add_project")(function* add_project(
            command: HubCommandOf<"add_project">,
          ) {
            const project = yield* addProject(fs, paths, command.path);
            return AddProjectResponse.make({ project });
          }),
          archive_thread: Effect.fn("archive_thread")(function* archive_thread(
            command: HubCommandOf<"archive_thread">,
          ) {
            // Archive is visibility-only (CONTEXT.md: Archive): the trail,
            // session, and env are untouched; unarchive is always possible.
            const threadId = yield* resolveThreadId(command.threadId);
            const archived = yield* registry.archive(threadId);
            if (Option.isNone(archived)) {
              return yield* Effect.fail(
                new DaemonError({
                  code: "unknown_thread",
                  message: `unknown thread: ${command.threadId}`,
                }),
              );
            }
            const info = yield* infoOf(threadId);
            yield* emitThreadChanged(info);
            return ArchiveThreadResponse.make({ thread: info });
          }),
          browse_project_dirs: Effect.fn("browse_project_dirs")(function* browse_project_dirs(
            command: HubCommandOf<"browse_project_dirs">,
          ) {
            // One level of the add-project tree (CONTEXT.md: Add project):
            // the subdirectories of the requested path, candidates marked.
            const browse = yield* browseProjectDirs(fs, paths, command.path).pipe(
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
          create_thread: Effect.fn("create_thread")(function* create_thread(
            command: HubCommandOf<"create_thread">,
          ) {
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
            const record = yield* registry.create(createOptions);
            const info = yield* infoOf(record.id);
            yield* emitThreadChanged(info);
            return CreateThreadResponse.make({ thread: info });
          }),
          delete_skill: skillsNotServed,
          delete_thread: Effect.fn("delete_thread")(function* delete_thread(
            command: HubCommandOf<"delete_thread">,
          ) {
            const threadId = yield* resolveThreadId(command.threadId);
            // Capture the info before the record is removed — the broadcast
            // tells every console the thread is gone.
            const info = yield* infoOf(threadId);
            const hosts = yield* Ref.get(hostsRef);
            const host = hosts.get(threadId);
            if (host !== undefined) {
              yield* host.dispose();
              yield* Ref.update(hostsRef, (current) => {
                const next = new Map(current);
                next.delete(threadId);
                return next;
              });
            }
            yield* registry.delete(threadId);
            yield* emitThreadChanged(info);
            return DeleteThreadResponse.make({});
          }),
          get_thread: Effect.fn("get_thread")(function* get_thread(
            command: HubCommandOf<"get_thread">,
          ) {
            const threadId = yield* resolveThreadId(command.threadId);
            const info = yield* infoOf(threadId);
            return GetThreadResponse.make({ thread: info });
          }),
          import_pi_session: Effect.fn("import_pi_session")(function* import_pi_session(
            command: HubCommandOf<"import_pi_session">,
          ) {
            // Adoption is idempotent per pi session file: one thread per
            // source (the record's provenance field is the key).
            const records = yield* registry.list();
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
            const session = yield* readPiSession(fs, paths, command.path).pipe(
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
            const record = yield* registry.create({
              cwd: session.cwd,
              mode: "local",
              name,
              source: { kind: "pi", path: command.path, sessionId: session.id },
            });
            // Adopt the trail: replay the pi mutations into the thread's own
            // kv store, then back-fill the session id. A failure rolls the
            // record back — an import must be all-or-nothing.
            const importOutcome = yield* Effect.gen(function* importOutcome() {
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
              .pipe(Effect.provide(KvStore.file(fs, paths.threadTrailRoot(record.id))))
              .pipe(Effect.result);
            if (Result.isFailure(importOutcome)) {
              yield* registry.delete(record.id);
              return yield* Effect.fail(importOutcome.failure);
            }
            yield* registry.update(record.id, { sessionId: record.id });
            const info = yield* infoOf(record.id);
            yield* emitThreadChanged(info);
            return ImportPiSessionResponse.make({ thread: info });
          }),
          import_skill: skillsNotServed,
          list_pi_sessions: Effect.fn("list_pi_sessions")(function* list_pi_sessions(
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
                ? (yield* listProjects(fs, paths)).map((project) => project.path)
                : [nodePath.resolve(command.project)];
            const sessions = yield* listPiSessions(fs, paths, projects).pipe(
              Effect.mapError(
                (error) =>
                  new DaemonError({
                    cause: error,
                    code: "pi_sessions",
                    message: error.message,
                  }),
              ),
            );
            return ListPiSessionsResponse.make({ sessions });
          }),
          list_projects: Effect.fn("list_projects")(function* list_projects() {
            const projects = yield* listProjects(fs, paths);
            return ProjectResponse.make({ _tag: "list_projects", projects });
          }),
          list_skills: skillsNotServed,
          list_threads: Effect.fn("list_threads")(function* list_threads() {
            const records = yield* registry.list();
            const threads = yield* Effect.forEach(records, (record) => infoOf(record.id), {
              concurrency: "unbounded",
            });
            return ListThreadsResponse.make({ threads });
          }),
          remove_project: Effect.fn("remove_project")(function* remove_project(
            command: HubCommandOf<"remove_project">,
          ) {
            yield* removeProject(fs, paths, command.path);
            return RemoveProjectResponse.make({});
          }),
          rename_thread: Effect.fn("rename_thread")(function* rename_thread(
            command: HubCommandOf<"rename_thread">,
          ) {
            const threadId = yield* resolveThreadId(command.threadId);
            const name = command.name.trim();
            if (name.length === 0) {
              return yield* Effect.fail(
                new DaemonError({ code: "empty_name", message: "name must not be empty" }),
              );
            }
            // A user rename wins over auto-title forever (CONTEXT.md: Auto-title).
            yield* registry.update(threadId, { name, nameAuto: false });
            const info = yield* infoOf(threadId);
            yield* emitThreadChanged(info);
            return RenameThreadResponse.make({ thread: info });
          }),
          unarchive_thread: Effect.fn("unarchive_thread")(function* unarchive_thread(
            command: HubCommandOf<"unarchive_thread">,
          ) {
            const threadId = yield* resolveThreadId(command.threadId);
            const unarchived = yield* registry.unarchive(threadId);
            if (Option.isNone(unarchived)) {
              return yield* Effect.fail(
                new DaemonError({
                  code: "unknown_thread",
                  message: `unknown thread: ${command.threadId}`,
                }),
              );
            }
            const info = yield* infoOf(threadId);
            yield* emitThreadChanged(info);
            return UnarchiveThreadResponse.make({ thread: info });
          }),
        }),
      );
    });

    /** `catalog.available()` already projected to wire info. */
    const availableModels = () =>
      catalog
        .available()
        .pipe(Effect.map((models) => models.map((model) => catalog.toWireInfo(model))));

    /** Lazy host: constructed on first command; crashed hosts rebuild. */
    const hostFor = (threadId: string) =>
      hostSemaphore.withPermit(
        Effect.gen(function* buildHost() {
          const hosts = yield* Ref.get(hostsRef);
          const existing = hosts.get(threadId);
          if (existing !== undefined) {
            if (existing.threadState !== "crashed") {
              return existing;
            }
            yield* log(`thread ${threadId.slice(0, 8)} crashed; rebuilding host`);
            yield* existing.dispose();
            yield* Ref.update(hostsRef, (current) => {
              const next = new Map(current);
              next.delete(threadId);
              return next;
            });
          }
          const record = yield* registry.get(threadId);
          if (Option.isNone(record)) {
            return yield* Effect.fail(
              new SessionHostError({
                kind: "unknown_thread",
                message: `unknown thread: ${threadId}`,
              }),
            );
          }
          // The registry's setState is an in-memory ref (not persisted, not
          // broadcast); consoles must hear working → idle, so wrap it: every
          // state push fans a thread_changed out (CONTEXT.md: Thread — state
          // is a channel every console reads). The host view is the narrow
          // seam (get/update/setState) adapted over the full registry.
          const broadcastState = (id: string, state: ThreadState) =>
            registry.setState(id, state).pipe(
              Effect.flatMap(() => infoOf(id)),
              Effect.flatMap((info) => emitThreadChanged(info)),
              Effect.ignore,
            );
          const registryWithBroadcast: HostRegistryApi = {
            get: (id) => registry.get(id),
            setState: (id, state) => broadcastState(id, state),
            update: (id, patch) => registry.update(id, patch),
          };
          const host = yield* SessionHost.create({
            catalog,
            env: new LocalEnv(record.value.cwd, fs),
            onRecordChanged: (changed) => {
              void Effect.runFork(
                infoOf(changed.id)
                  .pipe(Effect.flatMap((info) => emitThreadChanged(info)))
                  .pipe(Effect.catch(() => Effect.void)),
              );
            },
            record: record.value,
            registry: registryWithBroadcast,
            sink: (event) => {
              void Effect.runFork(emitSessionEvent(threadId, event));
            },
            threadId,
          }).pipe(
            // The daemon's trail is file-backed under the thread's directory;
            // a Durable Object passes its own storage through the same seam.
            Effect.provide(KvStore.file(fs, paths.threadTrailRoot(threadId))),
          );
          yield* Ref.update(hostsRef, (current) => new Map(current).set(threadId, host));
          return host;
        }),
      );

    /** The live host only when the thread's session has already started; none otherwise. */
    const readOnlyHost = Effect.fn("readOnlyHost")(function* readOnlyHost(threadId: string) {
      const live = yield* Ref.get(hostsRef);
      const existing = live.get(threadId);
      if (existing !== undefined) {
        return Option.some(existing);
      }
      const record = yield* registry.get(threadId);
      if (Option.isNone(record)) {
        return Option.none();
      }
      const started = yield* sessionStarted(fs, paths, record, threadId);
      if (!started) {
        return Option.none();
      }
      return Option.some(yield* hostFor(threadId));
    });

    const handleSessionCommand = Effect.fn("handleSessionCommand")(function* handleSessionCommand(
      threadIdInput: string,
      command: SessionCommandType,
    ) {
      const threadId = yield* resolveThreadId(threadIdInput);
      return yield* runSessionCommand(
        { availableModels, hostFor, readOnlyHost },
        threadId,
        command,
      );
    });

    const core: WireServerApi = yield* WireServer.make({
      handlers: {
        runHubCommand,
        runSessionCommand: handleSessionCommand,
      },
      log,
      pid: process.pid,
      // The token is re-read per hello, so a console that connects after a
      // credentials change authenticates against the current auth.json.
      token: () => ensureAuthToken(fs, paths).pipe(Effect.catch(() => Effect.succeed(""))),
    });
    yield* Ref.set(broadcastRef, (event) => core.broadcast(event));

    const close = Effect.fn("close")(function* close() {
      const closed = yield* Ref.get(closedRef);
      if (closed) {
        return;
      }
      yield* Ref.set(closedRef, true);
      yield* core.close();
      const hosts = yield* Ref.get(hostsRef);
      yield* Effect.forEach([...hosts.values()], (host) => host.dispose(), { discard: true });
      yield* Ref.set(hostsRef, new Map());
      const server = yield* Ref.get(serverRef);
      if (Option.isSome(server)) {
        yield* Effect.callback((resume) => {
          server.value.close(() => {
            resume(Effect.void);
          });
          return Effect.void;
        });
      }
      yield* fs.remove(urlPath, { force: true }).pipe(Effect.catch(() => Effect.void));
    });

    yield* ensureSakuDirs(fs, paths).pipe(Effect.mapError(startup("ensure saku dirs")));
    yield* ensureAuthToken(fs, paths).pipe(Effect.mapError(startup("ensure auth token")));
    yield* fs.remove(urlPath, { force: true }).pipe(Effect.catch(() => Effect.void));
    // The ephemeral listener (shared with the hub's server, @saku/wire/server):
    // resolves on listening, closes on interruption; socket errors are
    // startup failures, exactly as the hand-rolled listener was.
    const server = yield* listenWs<DaemonError>({
      onConnection: (socket) => {
        void Effect.runFork(Effect.scoped(core.runConnection(socket)));
      },
      onError: (error) => {
        // The listenWs mapper is a sync callback: fork the log.
        void Effect.runFork(log(`server error: ${error.message}`));
        return new DaemonError({ cause: error, code: "startup", message: error.message });
      },
    });
    // The URL file is written after listening (the CLI reads it to connect).
    const url = wsUrlOf(server);
    void Effect.runFork(
      fs.writeFileString(urlPath, `${url}\n`).pipe(
        Effect.result,
        Effect.flatMap((outcome) =>
          Result.isFailure(outcome)
            ? log(`failed to write ${urlPath}: ${outcome.failure.message}`)
            : Effect.void,
        ),
      ),
    );
    yield* log(`listening on ${url}`);
    yield* Ref.set(serverRef, Option.some(server));
    yield* Effect.addFinalizer(() => close());
    return { close, url };
  }),
}) {}

/**
 * The daemon as a scoped resource: start listening on acquire, close on
 * release. Requires the registry and catalog services.
 */
export const SakuDaemonLive = (options: DaemonOptions = {}) =>
  Layer.effect(
    SakuDaemon,
    Effect.gen(function* buildLive() {
      const registry = yield* ThreadRegistry;
      const catalog = yield* ModelCatalog;
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Paths;
      const daemon = yield* SakuDaemon.make({
        catalog,
        fs,
        paths,
        registry,
        urlPath: options.urlPath ?? paths.workerUrlPath,
      });
      // The layer's scope stays open for the program's lifetime; closing it
      // (interruption, program end) runs the daemon's teardown.
      yield* Effect.addFinalizer(() => daemon.close());
      return daemon;
    }),
  );

/**
 * The daemon over the test stack: `PathsTest`'s temp layout (pass `home`
 * to pin one layout), disk registry, builtin catalog. Tests provide this
 * plus a FileSystem layer.
 */
export const SakuDaemonTest = (home?: string) =>
  SakuDaemonLive().pipe(
    Layer.provide(ThreadRegistryTest(home)),
    Layer.provide(ModelCatalogTest(home)),
    // The catalog and registry layers hide their internal Paths; the daemon
    // reads it directly too, so provide it here as well (one shared layout).
    Layer.provide(PathsTest(home)),
  );

/** The daemon with its dependencies wired: what daemon-entry runs. */
export const SakuDaemonLayer: Layer.Layer<SakuDaemon, DaemonError | RegistryError> =
  SakuDaemonLive().pipe(
    Layer.provide(ThreadRegistryLive),
    // The registry's store: a file backend rooted at the threads dir (the
    // same boundary the per-thread trail stores cross, one root up).
    Layer.provide(RegistryKvLive),
    Layer.provide(ModelCatalogLive()),
    Layer.provide(PathsLive),
    Layer.provide(NodeFileSystem.layer),
  );
