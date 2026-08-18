/**
 * The daemon (daemon.ts): the worker's WebSocket server, provided as a
 * scoped resource layer (`SakuDaemonLive` — the daemon-entry process runs
 * it under `Effect.never` and interrupts the fiber to shut down).
 *
 * Serves the wire protocol (ADR 0004) over WebSocket on 127.0.0.1 (random
 * port), authenticates consoles by token, routes wire commands to the
 * registry or to per-thread session hosts, and fans session events out to
 * every connected console (stateless routing — no attach/detach). The URL
 * is published to `~/.saku/worker.url` (the CLI reads it to connect).
 *
 * This is the transitional local spine: the hub (ADR 0001) will own the
 * wire's server side in production; the daemon keeps the local stack alive
 * and speaks exactly the same protocol. Both implementations share the
 * transport-free connection core of `@saku/wire/server` (hello/version
 * auth, command routing, fan-out) and the session-command dispatch of
 * `./session-commands.ts` — the daemon contributes only the hub-command
 * dispatch (`./hub-commands.ts`), the lazy per-thread hosts
 * (`./host-cache.ts`), and the lifecycle.
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
import { Context, Effect, FileSystem, Layer, Option, Ref, Result } from "effect";

import { EventFrame, ThreadChanged, resolveThread } from "@saku/wire";
import type {
  SessionCommand as SessionCommandType,
  SessionWireEvent,
  ThreadInfo,
  WireEvent,
} from "@saku/wire";
import { listenWs, WireServer, wsUrlOf } from "@saku/wire/server";
import type { WireServerApi } from "@saku/wire/server";

import { ensureAuthToken, ensureSakuDirs } from "./auth.ts";
import { DaemonError } from "./daemon-error.ts";
import { Paths, PathsLive, PathsTest } from "./paths.ts";
import type { PathsLayout } from "./paths.ts";
import {
  ThreadRegistry,
  ThreadRegistryLive,
  ThreadRegistryTest,
  RegistryKvLive,
} from "./registry.ts";
import type { ThreadRegistryApi } from "./registry.ts";
import { ModelCatalog, ModelCatalogLive, ModelCatalogTest } from "./model-catalog.ts";
import type { ModelCatalogApi } from "./model-catalog.ts";
import { runSessionCommand } from "./session-commands.ts";
import { runHubCommand } from "./hub-commands.ts";
import type { HubCommandDeps } from "./hub-commands.ts";
import { HostCache } from "./host-cache.ts";

export interface DaemonOptions {
  /** Override the URL file path (tests). Defaults to ~/.saku/worker.url. */
  urlPath?: string;
}

/** The daemon's log line (the process's stdout is the worker.log file). */
const log = (message: string) => Effect.logInfo(`[saku-worker] ${message}`);

/**
 * Fork a fire-and-forget effect with a terminal error handler: a failing
 * socket callback must never be silent (the socket events carry no error
 * channel back to the caller), so every fork logs its full cause.
 */
const fork = <E>(effect: Effect.Effect<void, E>) =>
  void Effect.runFork(effect.pipe(Effect.catchCause(Effect.logError)));

/** The daemon's startup phase failures (dirs/token/listen), all tagged. */
const startup = (message: string) => (error: Error) =>
  new DaemonError({
    cause: error,
    code: "startup",
    message: `${message}: ${error.message}`,
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
  make: Effect.fn("SakuDaemon.make")(function* (options: {
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
    const closedRef = yield* Ref.make(false);
    const serverRef = yield* Ref.make<Option.Option<WebSocketServer>>(Option.none());

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

    /** Resolve a user-supplied thread id/name/prefix against the registry. */
    const resolveThreadId = Effect.fn("resolveThreadId")(function* (input: string) {
      const threads = yield* registry.list();
      const resolved = resolveThread(threads, input);
      if (Result.isFailure(resolved)) {
        return yield* Effect.fail(
          new DaemonError({ code: "resolution", message: resolved.failure }),
        );
      }
      return resolved.success.id;
    });

    // The lazy per-thread hosts: the host cache owns the hosts map, the
    // construction semaphore, and the state→thread_changed broadcast wrap.
    const hostCache = yield* HostCache.make({
      catalog,
      emitSessionEvent,
      emitThreadChanged,
      fs,
      log,
      paths,
      registry,
    });

    /** `catalog.available()` already projected to wire info. */
    const availableModels = () =>
      catalog
        .available()
        .pipe(Effect.map((models) => models.map((model) => catalog.toWireInfo(model))));

    const handleSessionCommand = Effect.fn("handleSessionCommand")(function* (
      threadIdInput: string,
      command: SessionCommandType,
    ) {
      const threadId = yield* resolveThreadId(threadIdInput);
      return yield* runSessionCommand(
        {
          availableModels,
          hostFor: hostCache.hostFor,
          readOnlyHost: hostCache.readOnlyHost,
        },
        threadId,
        command,
      );
    });

    const hubCommandDeps: HubCommandDeps = {
      emitThreadChanged,
      fs,
      hostCache,
      paths,
      registry,
      resolveThreadId,
    };

    const core: WireServerApi = yield* WireServer.make({
      handlers: {
        runHubCommand: (command) => runHubCommand(hubCommandDeps, command),
        runSessionCommand: handleSessionCommand,
      },
      log,
      pid: process.pid,
      // The token is re-read per hello, so a console that connects after a
      // credentials change authenticates against the current auth.json.
      token: () => ensureAuthToken(fs, paths).pipe(Effect.catch(() => Effect.succeed(""))),
    });
    yield* Ref.set(broadcastRef, (event) => core.broadcast(event));

    const close = Effect.fn("close")(function* () {
      const closed = yield* Ref.get(closedRef);
      if (closed) {
        return;
      }
      yield* Ref.set(closedRef, true);
      yield* core.close();
      yield* hostCache.disposeAll();
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
        fork(Effect.scoped(core.runConnection(socket)));
      },
      onError: (error) => {
        // The listenWs mapper is a sync callback: fork the log.
        fork(log(`server error: ${error.message}`));
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
    Effect.gen(function* () {
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
export const SakuDaemonLayer: Layer.Layer<SakuDaemon, DaemonError> =
  SakuDaemonLive().pipe(
    Layer.provide(ThreadRegistryLive),
    // The registry's store: a file backend rooted at the threads dir (the
    // same boundary the per-thread trail stores cross, one root up).
    Layer.provide(RegistryKvLive),
    Layer.provide(ModelCatalogLive()),
    Layer.provide(PathsLive),
    Layer.provide(NodeFileSystem.layer),
  );
