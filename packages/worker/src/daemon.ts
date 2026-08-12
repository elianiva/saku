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
 * and speaks exactly the same protocol, so the wire's contract is exercised
 * by two real implementations until the rework lands.
 *
 * `makeSakuDaemon` builds the daemon inside an `Effect.gen` (the same shape
 * as `@effect/platform-node`'s `NodeSocketServer` factory): all state that
 * crosses the socket boundary lives in `Ref`s made with `Ref.make`, command
 * handlers are `Effect.gen` pipelines, and socket events are plain callbacks
 * that fork Effects into the runtime (the boundary lutra's worker layers
 * draw). The daemon is provided as the `SakuDaemon` service; the layer's
 * scope holds it open, and closing the scope runs the finalizer.
 */

import { WebSocketServer, type WebSocket } from "ws";
import { NodeFileSystem } from "@effect/platform-node";
import { Context, Effect, FileSystem, Layer, Option, Ref, Result, Schema, Scope, Semaphore } from "effect";

import {
  AbortResponse,
  BranchResponse,
  CompactResponse,
  CreateThreadResponse,
  DeleteThreadResponse,
  ErrorEvent,
  EventFrame,
  FollowUpResponse,
  GetAvailableModelsResponse,
  GetAvailableThinkingLevelsResponse,
  GetEntriesResponse,
  GetSessionStatsResponse,
  GetStateResponse,
  GetThreadResponse,
  Hello,
  HelloOk,
  ListThreadsResponse,
  PromptResponse,
  RenameThreadResponse,
  ResponseOk,
  ResponseError,
  SessionCommand,
  SetAutoCompactionResponse,
  SetFollowUpModeResponse,
  SetModelResponse,
  SetSessionNameResponse,
  SetSteeringModeResponse,
  SetThinkingLevelResponse,
  SteerResponse,
  THINKING_LEVELS,
  ThreadChanged,
  WIRE_VERSION,
  WireCommand,
  decodeFrame,
  parseFrame,
  resolveThread,
  serializeFrame,
  type ResponsePayload,
  type SessionCommand as SessionCommandType,
  type SessionWireEvent,
  type SkillCommand,
  type ThreadCommand,
  type ThreadInfo,
  type WireEvent,
} from "@saku/wire";

import { ensureAuthToken, ensureSakuDirs } from "./auth.ts";
import { getThreadTrailRoot, getWorkerUrlPath } from "./paths.ts";
import {
  ThreadRegistry,
  ThreadRegistryLive,
  RegistryError,
  type ThreadRecord,
  type ThreadRegistryShape,
} from "./registry.ts";
import { ModelCatalog, ModelCatalogLive, type ModelCatalogShape } from "./model-catalog.ts";
import { SessionHost, SessionHostError } from "./session-host.ts";

const DECODE_COMMAND = Schema.decodeUnknownSync(Schema.Union([Hello, WireCommand]));

/** Whether a decoded command is thread-scoped (session vocabulary vs. hub-level). */
const isSessionCommand = (c: SessionCommandType | ThreadCommand | SkillCommand): c is SessionCommandType =>
  Schema.is(SessionCommand)(c);

interface Client {
  readonly socket: WebSocket;
  readonly authed: Ref.Ref<boolean>;
}

export interface DaemonOptions {
  /** Override the URL file path (tests). Defaults to ~/.saku/worker.url. */
  urlPath?: string;
}

/** A command-level failure owned by the daemon (resolve/validation). */
export class DaemonError extends Schema.TaggedError<DaemonError>()("DaemonError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

/** The failures a wire command handler can produce. */
type CommandError = DaemonError | RegistryError | SessionHostError;

/** The daemon's service surface. */
export interface SakuDaemonShape {
  /** The ws:// URL the daemon listens on. */
  readonly url: string;
  /** Stop the daemon: drop clients, dispose hosts, close the server. */
  readonly close: () => Effect.Effect<void, never>;
}

export class SakuDaemon extends Context.Service<SakuDaemon, SakuDaemonShape>()("SakuDaemon") {}

/** Whether a thread's pi session has ever been created (started). */
const sessionStarted = (
  fs: FileSystem.FileSystem,
  record: Option.Option<ThreadRecord>,
  threadId: string,
): Effect.Effect<boolean, never, never> =>
  Effect.gen(function* () {
    if (Option.isSome(record) && record.value.sessionId !== null) return true;
    // The session's metadata key is written before any mutation (do-session.ts),
    // so its presence means the session was created.
    const metaPath = `${getThreadTrailRoot(threadId)}/session/${threadId}/meta`;
    return yield* fs.exists(metaPath).pipe(Effect.catch(() => Effect.succeed(false)));
  });

/**
 * Build the daemon: refs first, then the handlers as closures over them,
 * then the startup sequence (dirs, token, listen). The daemon's log is the
 * process's stdout — the CLI spawns it with worker.log as stdout, so
 * console output IS the log file.
 */
export const makeSakuDaemon = (options: {
  registry: ThreadRegistryShape;
  catalog: ModelCatalogShape;
  fs: FileSystem.FileSystem;
  urlPath: string;
}): Effect.Effect<SakuDaemonShape, Error, Scope.Scope> =>
  Effect.gen(function* () {
    const { registry, catalog, fs, urlPath } = options;
    const clientsRef = yield* Ref.make<ReadonlySet<Client>>(new Set());
    const hostsRef = yield* Ref.make<ReadonlyMap<string, SessionHost>>(new Map());
    const closedRef = yield* Ref.make(false);
    const serverRef = yield* Ref.make<Option.Option<WebSocketServer>>(Option.none());
    // Serializes host construction: two concurrent first-touch commands must
    // not build two live hosts for one thread.
    const hostSemaphore = yield* Semaphore.make(1);

    const log = (message: string): void => {
      console.log(`[saku-worker] ${message}`);
    };

    // -- connections ---------------------------------------------------------

    const send = (client: Client, event: WireEvent): Effect.Effect<void, never> =>
      Effect.sync(() => {
        // A socket that closed between the check and the send is a no-op;
        // the close handler cleans the client up.
        Result.try(() => client.socket.send(serializeFrame(event)));
      });

    const broadcast = (event: WireEvent): Effect.Effect<void, never> =>
      Ref.get(clientsRef).pipe(
        Effect.flatMap((clients) =>
          Effect.forEach(
            clients,
            (client) =>
              Ref.get(client.authed).pipe(Effect.flatMap((authed) => (authed ? send(client, event) : Effect.void))),
            { discard: true },
          ),
        ),
      );

    /** All consoles see every session event (stateless routing). */
    const emitSessionEvent = (threadId: string, event: SessionWireEvent): Effect.Effect<void, never> =>
      broadcast(EventFrame.make({ threadId, event }));

    const emitThreadChanged = (thread: ThreadInfo): Effect.Effect<void, never> =>
      broadcast(ThreadChanged.make({ thread }));

    // -- thread state helpers ------------------------------------------------

    const tailSeqOf = (threadId: string): Effect.Effect<number, SessionHostError, never> =>
      Ref.get(hostsRef).pipe(
        Effect.flatMap((hosts) => {
          const host = hosts.get(threadId);
          if (host === undefined) return Effect.succeed(0);
          return host.getEntries().pipe(Effect.map(({ tailSeq }) => tailSeq));
        }),
      );

    const infoOf = (threadId: string): Effect.Effect<ThreadInfo, CommandError, never> =>
      Effect.gen(function* () {
        const tailSeq = yield* tailSeqOf(threadId);
        const info = yield* registry.toInfo(threadId, tailSeq);
        if (Option.isNone(info)) {
          return yield* Effect.fail(new DaemonError({ message: `unknown thread: ${threadId}` }));
        }
        return info.value;
      });

    /** Resolve a user-supplied thread id/name/prefix against the registry. */
    const resolveThreadId = (input: string): Effect.Effect<string, DaemonError | RegistryError, never> =>
      Effect.gen(function* () {
        const threads = yield* registry.list();
        const resolved = resolveThread(threads, input);
        if (Result.isFailure(resolved)) {
          return yield* Effect.fail(new DaemonError({ message: resolved.failure }));
        }
        return resolved.success.id;
      });

    // -- command routing -----------------------------------------------------

    const handleHello = (client: Client, hello: Hello): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        const expected = yield* ensureAuthToken(fs).pipe(Effect.catch(() => Effect.succeed("")));
        if (hello.token !== expected) {
          yield* send(client, ErrorEvent.make({ message: "invalid token" }));
          client.socket.close();
          return;
        }
        yield* Ref.set(client.authed, true);
        yield* send(client, HelloOk.make({ pid: process.pid, version: WIRE_VERSION }));
      });

    const handleCommand = (client: Client, command: WireCommand): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        const authed = yield* Ref.get(client.authed);
        if (!authed) {
          yield* send(client, ErrorEvent.make({ message: "hello first" }));
          return;
        }
        const id = command.id;
        // Routing by command kind: session commands are thread-scoped; threads
        // and skills are hub-level. A session command without a threadId is a
        // protocol error, not a hub command.
        let run: Effect.Effect<void, CommandError, never>;
        if (isSessionCommand(command.command)) {
          if (command.threadId === undefined) {
            run = Effect.fail(new DaemonError({ message: "session command without a threadId" }));
          } else {
            run = handleSessionCommand(client, id, command.threadId, command.command);
          }
        } else {
          run = handleHubCommand(client, id, command.command);
        }
        yield* Effect.catch(run, (error) => respondCommandFailure(client, id, error));
      });

    const respondCommandFailure = (client: Client, id: string | undefined, error: unknown): Effect.Effect<void, never> => {
      const message = error instanceof Error ? error.message : String(error);
      if (id === undefined) return send(client, ErrorEvent.make({ message }));
      return send(client, ResponseError.make({ id, ok: false, error: message }));
    };

    const respond = (client: Client, id: string | undefined, payload: ResponsePayload): Effect.Effect<void, never> => {
      if (id === undefined) return Effect.void;
      return send(client, ResponseOk.make({ id, ok: true, payload }));
    };

    const handleHubCommand = (
      client: Client,
      id: string | undefined,
      command: ThreadCommand | SkillCommand,
    ): Effect.Effect<void, CommandError, never> =>
      Effect.gen(function* () {
        const payload = yield* runHubCommand(command);
        yield* respond(client, id, payload);
      });

    const runHubCommand = (command: ThreadCommand | SkillCommand): Effect.Effect<ResponsePayload, CommandError, never> =>
      Effect.gen(function* () {
        switch (command._tag) {
          case "list_threads": {
            const records = yield* registry.list();
            const threads: ThreadInfo[] = [];
            for (const record of records) {
              threads.push(yield* infoOf(record.id));
            }
            return ListThreadsResponse.make({ threads });
          }
          case "create_thread": {
            const record = yield* registry.create({
              name: command.name,
              ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
              ...(command.mode === undefined ? {} : { mode: command.mode }),
              ...(command.autoName === undefined ? {} : { autoName: command.autoName }),
            });
            const info = yield* infoOf(record.id);
            yield* emitThreadChanged(info);
            return CreateThreadResponse.make({ thread: info });
          }
          case "get_thread": {
            const threadId = yield* resolveThreadId(command.threadId);
            const info = yield* infoOf(threadId);
            return GetThreadResponse.make({ thread: info });
          }
          case "delete_thread": {
            const threadId = yield* resolveThreadId(command.threadId);
            // Capture the info before the record is removed — the broadcast
            // tells every console the thread is gone.
            const info = yield* infoOf(threadId);
            const hosts = yield* Ref.get(hostsRef);
            const host = hosts.get(threadId);
            if (host !== undefined) {
              yield* host.dispose();
              yield* Ref.update(hostsRef, (hosts) => {
                const next = new Map(hosts);
                next.delete(threadId);
                return next;
              });
            }
            yield* registry.delete(threadId);
            yield* emitThreadChanged(info);
            return DeleteThreadResponse.make({});
          }
          case "rename_thread": {
            const threadId = yield* resolveThreadId(command.threadId);
            const name = command.name.trim();
            if (name.length === 0) {
              return yield* Effect.fail(new DaemonError({ message: "name must not be empty" }));
            }
            // A user rename wins over auto-title forever (CONTEXT.md: Auto-title).
            yield* registry.update(threadId, { name, nameAuto: false });
            const info = yield* infoOf(threadId);
            yield* emitThreadChanged(info);
            return RenameThreadResponse.make({ thread: info });
          }
          case "list_skills":
          case "import_skill":
          case "delete_skill":
            // The skills store is hub-hosted (ADR 0007); the local daemon
            // deliberately does not implement it.
            return yield* Effect.fail(
              new DaemonError({ message: "skills are served by the hub, not the local daemon" }),
            );
          default: {
            // Exhaustiveness: a new command tag must be handled here.
            const exhaustive: never = command;
            void exhaustive;
            return yield* Effect.fail(new DaemonError({ message: "unknown command" }));
          }
        }
      });

    const handleSessionCommand = (
      client: Client,
      id: string | undefined,
      threadIdInput: string,
      command: SessionCommandType,
    ): Effect.Effect<void, CommandError, never> =>
      Effect.gen(function* () {
        const threadId = yield* resolveThreadId(threadIdInput);
        const payload = yield* runSessionCommand(threadId, command);
        yield* respond(client, id, payload);
      });

    const runSessionCommand = (
      threadId: string,
      command: SessionCommandType,
    ): Effect.Effect<ResponsePayload, CommandError, never> =>
      Effect.gen(function* () {
        // Read-only commands are served without a session host: a thread that
        // has never started answers from the registry/catalog alone, so
        // browsing never starts the thread's pi session. The session starts
        // on the first mutating command below.
        switch (command._tag) {
          case "get_entries": {
            const readOnly = yield* readOnlyHost(threadId);
            if (Option.isNone(readOnly)) {
              return GetEntriesResponse.make({ entries: [], tailSeq: 0, leafId: null });
            }
            const { entries, tailSeq, leafId } = yield* readOnly.value.getEntries(command.sinceSeq);
            return GetEntriesResponse.make({ entries, tailSeq, leafId });
          }
          case "get_state": {
            const readOnly = yield* readOnlyHost(threadId);
            if (Option.isNone(readOnly)) {
              return GetStateResponse.make({
                state: { sessionId: null, state: "idle", tailSeq: 0, model: null, thinkingLevel: "off" },
              });
            }
            const state = yield* readOnly.value.getState();
            return GetStateResponse.make({ state });
          }
          case "get_available_models": {
            const models = yield* catalog.available();
            return GetAvailableModelsResponse.make({ models: models.map((m) => catalog.toWireInfo(m)) });
          }
          case "get_available_thinking_levels": {
            const readOnly = yield* readOnlyHost(threadId);
            const levels =
              Option.isNone(readOnly) ? [...THINKING_LEVELS] : yield* readOnly.value.getAvailableThinkingLevels();
            return GetAvailableThinkingLevelsResponse.make({ levels });
          }

          // -- mutating commands: the thread starts here ----------------------
          case "prompt": {
            const host = yield* hostFor(threadId);
            yield* host.prompt(command.text, command.images);
            return PromptResponse.make({});
          }
          case "steer": {
            const host = yield* hostFor(threadId);
            yield* host.steer(command.text);
            return SteerResponse.make({});
          }
          case "follow_up": {
            const host = yield* hostFor(threadId);
            yield* host.followUp(command.text);
            return FollowUpResponse.make({});
          }
          case "abort": {
            const host = yield* hostFor(threadId);
            yield* host.abort();
            return AbortResponse.make({});
          }
          case "set_steering_mode": {
            const host = yield* hostFor(threadId);
            yield* host.setSteeringMode(command.mode);
            return SetSteeringModeResponse.make({});
          }
          case "set_follow_up_mode": {
            const host = yield* hostFor(threadId);
            yield* host.setFollowUpMode(command.mode);
            return SetFollowUpModeResponse.make({});
          }
          case "compact": {
            const host = yield* hostFor(threadId);
            const result = yield* host.compact(command.customInstructions);
            return CompactResponse.make({ result });
          }
          case "set_auto_compaction": {
            const host = yield* hostFor(threadId);
            yield* host.setAutoCompaction(command.enabled);
            return SetAutoCompactionResponse.make({});
          }
          case "set_model": {
            const host = yield* hostFor(threadId);
            const model = yield* host.setModel(command.provider, command.modelId);
            return SetModelResponse.make({ model });
          }
          case "set_thinking_level": {
            const host = yield* hostFor(threadId);
            const level = yield* host.setThinkingLevel(command.level);
            return SetThinkingLevelResponse.make({ level });
          }
          case "branch": {
            const host = yield* hostFor(threadId);
            const leafId = yield* host.branch(command.entryId);
            return BranchResponse.make({ leafId });
          }
          case "get_session_stats": {
            const host = yield* hostFor(threadId);
            const stats = yield* host.getSessionStats();
            return GetSessionStatsResponse.make({ stats });
          }
          case "set_session_name": {
            const host = yield* hostFor(threadId);
            yield* host.setSessionName(command.name);
            return SetSessionNameResponse.make({});
          }
          default: {
            // Exhaustiveness: a new SessionCommand tag must be handled here.
            const exhaustive: never = command;
            void exhaustive;
            return yield* Effect.fail(new DaemonError({ message: "unknown session command" }));
          }
        }
      });

    /** The live host only when the thread's session has already started; none otherwise. */
    const readOnlyHost = (threadId: string): Effect.Effect<Option.Option<SessionHost>, CommandError, never> =>
      Effect.gen(function* () {
        const live = yield* Ref.get(hostsRef);
        const existing = live.get(threadId);
        if (existing !== undefined) return Option.some(existing);
        const record = yield* registry.get(threadId);
        if (Option.isNone(record)) return Option.none();
        const started = yield* sessionStarted(fs, record, threadId);
        if (!started) return Option.none();
        return Option.some(yield* hostFor(threadId));
      });

    /** Lazy host: constructed on first command; crashed hosts rebuild. */
    const hostFor = (threadId: string): Effect.Effect<SessionHost, CommandError, never> =>
      hostSemaphore.withPermit(
        Effect.gen(function* () {
          const hosts = yield* Ref.get(hostsRef);
          const existing = hosts.get(threadId);
          if (existing !== undefined) {
            if (existing.threadState !== "crashed") return existing;
            log(`thread ${threadId.slice(0, 8)} crashed; rebuilding host`);
            yield* existing.dispose();
            yield* Ref.update(hostsRef, (hosts) => {
              const next = new Map(hosts);
              next.delete(threadId);
              return next;
            });
          }
          const record = yield* registry.get(threadId);
          if (Option.isNone(record)) {
            return yield* Effect.fail(new SessionHostError({ message: `unknown thread: ${threadId}` }));
          }
          const host = yield* SessionHost.create({
            threadId,
            record: record.value,
            fs,
            catalog,
            registry,
            sink: (event) => {
              void Effect.runFork(emitSessionEvent(threadId, event));
            },
            onRecordChanged: (changed) => {
              void Effect.runFork(
                infoOf(changed.id)
                  .pipe(Effect.flatMap((info) => emitThreadChanged(info)))
                  .pipe(Effect.catch(() => Effect.void)),
              );
            },
          });
          yield* Ref.update(hostsRef, (hosts) => new Map(hosts).set(threadId, host));
          return host;
        }),
      );

    /** One console connection: read frames, route commands, live until close. */
    const runConnection = (socket: WebSocket): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function* () {
        const authed = yield* Ref.make(false);
        const client: Client = { socket, authed };
        yield* Ref.update(clientsRef, (clients) => new Set(clients).add(client));
        yield* Effect.addFinalizer(() =>
          Ref.update(clientsRef, (clients) => {
            const next = new Set(clients);
            next.delete(client);
            return next;
          }),
        );
        const onMessage = (data: unknown): void => {
          const value = Result.try(() => parseFrame(decodeFrame(data)));
          if (Result.isFailure(value)) {
            void Effect.runFork(send(client, ErrorEvent.make({ message: "malformed JSON frame" })));
            return;
          }
          const decoded = Result.try(() => DECODE_COMMAND(value.success));
          if (Result.isFailure(decoded)) {
            void Effect.runFork(send(client, ErrorEvent.make({ message: "undecodable message" })));
            return;
          }
          if (decoded.success._tag === "hello") {
            void Effect.runFork(handleHello(client, decoded.success));
          } else {
            void Effect.runFork(handleCommand(client, decoded.success));
          }
        };
        const onError = (error: Error): void => {
          log(`socket error: ${error.message}`);
        };
        socket.on("message", onMessage);
        socket.on("error", onError);
        // Resolve when the socket closes; the scope's finalizer then drops the client.
        yield* Effect.callback<void>((resume) => {
          const onClose = (): void => {
            resume(Effect.void);
          };
          socket.once("close", onClose);
          return Effect.sync(() => socket.off("close", onClose));
        });
      });

    const handleConnection = (socket: WebSocket): void => {
      void Effect.runFork(Effect.scoped(runConnection(socket)));
    };

    // -- lifecycle -----------------------------------------------------------

    const close = (): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        const closed = yield* Ref.get(closedRef);
        if (closed) return;
        yield* Ref.set(closedRef, true);
        const clients = yield* Ref.get(clientsRef);
        yield* Effect.forEach(clients, (client) => Effect.sync(() => client.socket.close()), { discard: true });
        yield* Ref.set(clientsRef, new Set());
        const hosts = yield* Ref.get(hostsRef);
        yield* Effect.forEach([...hosts.values()], (host) => host.dispose(), { discard: true });
        yield* Ref.set(hostsRef, new Map());
        const server = yield* Ref.get(serverRef);
        if (Option.isSome(server)) {
          yield* Effect.callback<void>((resume) => {
            server.value.close(() => resume(Effect.void));
            return Effect.void;
          });
        }
        yield* fs.remove(urlPath, { force: true }).pipe(Effect.catch(() => Effect.void));
      });

    // -- startup -------------------------------------------------------------

    yield* ensureSakuDirs(fs);
    yield* ensureAuthToken(fs);
    yield* fs.remove(urlPath, { force: true }).pipe(Effect.catch(() => Effect.void));
    const server = yield* Effect.callback<WebSocketServer, Error>((resume) => {
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      server.on("connection", (socket) => handleConnection(socket));
      server.on("error", (error) => {
        log(`server error: ${error.message}`);
        resume(Effect.fail(error));
      });
      server.on("listening", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          resume(Effect.fail(new Error("no listening address")));
          return;
        }
        const url = `ws://127.0.0.1:${address.port}`;
        void Effect.runFork(
          fs.writeFileString(urlPath, `${url}\n`).pipe(
            Effect.catch((error) => Effect.sync(() => log(`failed to write ${urlPath}: ${error.message}`))),
          ),
        );
        log(`listening on ${url}`);
        resume(Effect.succeed(server));
      });
      return Effect.sync(() => {
        server.close();
      });
    });
    yield* Ref.set(serverRef, Option.some(server));
    yield* Effect.addFinalizer(() => close());
    const address = server.address();
    const url = address !== null && typeof address !== "string" ? `ws://127.0.0.1:${address.port}` : "";
    return { url, close };
  });

/**
 * The daemon as a scoped resource: start listening on acquire, close on
 * release. Requires the registry and catalog services.
 */
export const SakuDaemonLive = (
  options: DaemonOptions = {},
): Layer.Layer<SakuDaemon, Error, ThreadRegistry | ModelCatalog | FileSystem.FileSystem> =>
  Layer.effect(
    SakuDaemon,
    Effect.gen(function* () {
      const registry = yield* ThreadRegistry;
      const catalog = yield* ModelCatalog;
      const fs = yield* FileSystem.FileSystem;
      const daemon = yield* makeSakuDaemon({
        registry,
        catalog,
        fs,
        urlPath: options.urlPath ?? getWorkerUrlPath(),
      });
      // The layer's scope stays open for the program's lifetime; closing it
      // (interruption, program end) runs the daemon's teardown.
      yield* Effect.addFinalizer(() => daemon.close());
      return daemon;
    }),
  );

/** The daemon with its dependencies wired: what daemon-entry runs. */
export const SakuDaemonLayer: Layer.Layer<SakuDaemon, Error> = SakuDaemonLive().pipe(
  Layer.provide(ThreadRegistryLive),
  Layer.provide(ModelCatalogLive()),
  Layer.provide(NodeFileSystem.layer),
);
