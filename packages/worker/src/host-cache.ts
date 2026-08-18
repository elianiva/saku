/**
 * Host cache (host-cache.ts): the daemon's lazy per-thread `SessionHost`
 * machinery — the hosts map, the construction semaphore, and the two
 * resolution modes the command dispatchers run on.
 *
 * `hostFor` constructs a thread's host on first touch and rebuilds a
 * crashed host on the next command; `readOnlyHost` answers with the live
 * host when the thread's session has already started (browsing never
 * starts a session, ADR 0004). `infoOf` projects a thread's current wire
 * info (live tail seq + registry record), and `broadcastState` wraps the
 * registry's in-memory state push so every state change fans a
 * `thread_changed` out to consoles (CONTEXT.md: Thread — state is a
 * channel every console reads). `disposeHost`/`disposeAll` tear hosts
 * down for delete and daemon shutdown.
 *
 * The cache is daemon-local plumbing built inside `SakuDaemon.make` (the
 * same shape as `SessionHost.create`): the wire core's fan-out is a ref
 * filled after `WireServer.make`, so the broadcast seam arrives as
 * callbacks (`emitSessionEvent`, `emitThreadChanged`).
 */

import { Effect, FileSystem, Option, Ref, Semaphore } from "effect";

import { LocalEnv } from "@saku/env";
import { KvStore } from "@saku/store";
import type { SessionWireEvent, ThreadInfo, ThreadState } from "@saku/wire";

import { DaemonError } from "./daemon-error.ts";
import type { ModelCatalogApi } from "./model-catalog.ts";
import type { PathsLayout } from "./paths.ts";
import type { HostRegistryApi, ThreadRecord, ThreadRegistryApi } from "./registry.ts";
import { SessionHost, SessionHostError } from "./session-host.ts";

/** The host cache's surface: what the command dispatchers and the daemon need. */
export interface HostCacheApi {
  /** The live host for a thread: lazy construction on first touch, crashed hosts rebuild. */
  readonly hostFor: (threadId: string) => Effect.Effect<SessionHost, SessionHostError>;
  /** The live host when the thread's session has already started; none otherwise. */
  readonly readOnlyHost: (
    threadId: string,
  ) => Effect.Effect<Option.Option<SessionHost>, SessionHostError>;
  /** The thread's current wire info (live tail seq + registry record). */
  readonly infoOf: (threadId: string) => Effect.Effect<ThreadInfo, DaemonError | SessionHostError>;
  /** Dispose the thread's live host if one exists (delete). */
  readonly disposeHost: (threadId: string) => Effect.Effect<void>;
  /** Dispose every live host (daemon shutdown). */
  readonly disposeAll: () => Effect.Effect<void>;
}

export interface HostCacheOptions {
  readonly registry: ThreadRegistryApi;
  readonly catalog: ModelCatalogApi;
  readonly fs: FileSystem.FileSystem;
  readonly paths: PathsLayout;
  /** Fan a session event out to every console (the wire core's broadcast). */
  readonly emitSessionEvent: (threadId: string, event: SessionWireEvent) => Effect.Effect<void>;
  /** Fan a thread_changed out to every console (the wire core's broadcast). */
  readonly emitThreadChanged: (thread: ThreadInfo) => Effect.Effect<void>;
  /** The daemon's log line (the process's stdout is the worker.log file). */
  readonly log: (message: string) => Effect.Effect<void>;
}

/**
 * Fork a fire-and-forget effect with a terminal error handler: the host
 * cache's callbacks (record-change broadcasts, session-event fan-out) run
 * outside any fiber, so a failure must be logged, never dropped.
 */
const fork = <E>(effect: Effect.Effect<void, E>) =>
  void Effect.runFork(effect.pipe(Effect.catchCause(Effect.logError)));

/** Build the host cache over the daemon's services and broadcast seam. */
export const HostCache = {
  make(options: HostCacheOptions): Effect.Effect<HostCacheApi> {
    return Effect.fn("HostCache.make")(function* () {
      const { registry, catalog, fs, paths, emitSessionEvent, emitThreadChanged, log } = options;
      const hostsRef = yield* Ref.make<ReadonlyMap<string, SessionHost>>(new Map());
      // Serializes host construction: two concurrent first-touch commands must
      // not build two live hosts for one thread.
      const hostSemaphore = yield* Semaphore.make(1);

      /** Whether a thread's pi session has ever been created (started). */
      const sessionStarted = Effect.fn("sessionStarted")(function* (
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

      const infoOf = Effect.fn("infoOf")(function* (threadId: string) {
        const tailSeq = yield* tailSeqOf(threadId);
        const info = yield* registry.toInfo(threadId, tailSeq);
        if (Option.isNone(info)) {
          return yield* Effect.fail(
            new DaemonError({ code: "unknown_thread", message: `unknown thread: ${threadId}` }),
          );
        }
        return info.value;
      });

      /** Lazy host: constructed on first command; crashed hosts rebuild. */
      const hostFor = (threadId: string) =>
        hostSemaphore.withPermit(
          Effect.gen(function* () {
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
                fork(
                  infoOf(changed.id).pipe(
                    Effect.flatMap((info) => emitThreadChanged(info)),
                  ),
                );
              },
              record: record.value,
              registry: registryWithBroadcast,
              sink: (event) => {
                fork(emitSessionEvent(threadId, event));
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
      const readOnlyHost = Effect.fn("readOnlyHost")(function* (threadId: string) {
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

      const disposeHost = Effect.fn("disposeHost")(function* (threadId: string) {
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
      });

      const disposeAll = Effect.fn("disposeAll")(function* () {
        const hosts = yield* Ref.get(hostsRef);
        yield* Effect.forEach([...hosts.values()], (host) => host.dispose(), { discard: true });
        yield* Ref.set(hostsRef, new Map());
      });

      return { disposeAll, disposeHost, hostFor, infoOf, readOnlyHost };
    })();
  },
};
