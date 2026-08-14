/**
 * Registry (registry.ts): the durable list of threads — the layer pi lacks
 * (a pi session has no name, no working directory, no hands policy, no
 * lifecycle state). The daemon's in-memory view, persisted to
 * `threads/<id>/thread.json` on every mutation (write temp file, rename).
 *
 * Provided as a service (`ThreadRegistryLive`) so the daemon's command
 * handlers compose it with the catalog; missing records are `Option.none`,
 * filesystem failures are `RegistryError`.
 */

import { Context, Effect, FileSystem, Layer, Option, Ref } from "effect";
import { ThreadMode, type ThreadInfo, type ThreadSource, type ThreadState } from "@saku/wire";

import { isNotFound } from "@saku/store";
import { Paths, PathsTest, type PathsShape } from "./paths.ts";
import { RegistryError } from "./registry-error.ts";
import { DECODE_THREAD_RECORD, type ThreadRecord } from "./registry-record.ts";

export { ThreadRecordSchema, type ThreadRecord } from "./registry-record.ts";

/**
 * The host's registry view: the narrow slice of the registry a
 * `SessionHost` drives (get/update/setState). The thread DO implements
 * exactly this; the daemon adapts its full registry over it. Hosts never
 * create/delete threads or project wire info — the hub/daemon own those.
 */
export interface HostRegistryShape {
  readonly get: (threadId: string) => Effect.Effect<Option.Option<ThreadRecord>, RegistryError>;
  readonly update: (
    threadId: string,
    patch: Partial<Pick<ThreadRecord, "name" | "sessionId" | "nameAuto">>,
  ) => Effect.Effect<Option.Option<ThreadRecord>, RegistryError>;
  /** Liveness state derived by hosts; not persisted (re-derived at boot). */
  readonly setState: (threadId: string, state: ThreadState) => Effect.Effect<void, never>;
}

export interface ThreadRegistryShape extends HostRegistryShape {
  readonly list: () => Effect.Effect<readonly ThreadRecord[], RegistryError>;
  readonly create: (input: {
    name: string;
    /** Defaults to the daemon's working directory (local-only semantics, ADR 0003). */
    cwd?: string;
    mode?: ThreadMode;
    autoName?: boolean;
    /** Adoption provenance for imported pi sessions (pi-sessions.ts). */
    source?: ThreadSource;
  }) => Effect.Effect<ThreadRecord, RegistryError>;
  /** Delete the record AND the thread's directory (sessions included). */
  readonly delete: (threadId: string) => Effect.Effect<boolean, RegistryError>;
  /** Wire projection: registry view + derived state. */
  readonly toInfo: (
    threadId: string,
    tailSeq: number,
  ) => Effect.Effect<Option.Option<ThreadInfo>, never>;
}

/** The durable thread index. Consoles only ever see it through the wire. */
export class ThreadRegistry extends Context.Service<ThreadRegistry, ThreadRegistryShape>()(
  "ThreadRegistry",
) {}

const THREAD_DIR_RE = /^[0-9a-f]{32}$/u;

const toRegistryError =
  (message: string, op: "list" | "persist") =>
  (error: unknown) =>
    new RegistryError({ message, op, cause: error });

/** Write one record atomically (temp file + rename). */
const persist = Effect.fn("persist")(function* (
  fs: FileSystem.FileSystem,
  paths: PathsShape,
  record: ThreadRecord,
) {
  yield* fs
    .makeDirectory(paths.threadDir(record.id), { recursive: true })
    .pipe(Effect.mapError(toRegistryError(`failed to persist thread ${record.id}`, "persist")));
  const path = paths.threadFile(record.id);
  const tmp = `${path}.tmp`;
  yield* fs
    .writeFileString(tmp, `${JSON.stringify(record, null, 2)}\n`)
    .pipe(Effect.mapError(toRegistryError(`failed to persist thread ${record.id}`, "persist")));
  yield* fs
    .rename(tmp, path)
    .pipe(Effect.mapError(toRegistryError(`failed to persist thread ${record.id}`, "persist")));
});

/**
 * Scan the threads directory. A thread with no record file was never touched;
 * corrupt records are skipped (the directory stays on disk).
 */
const loadRecords = Effect.fn("loadRecords")(function* (
  fs: FileSystem.FileSystem,
  paths: PathsShape,
) {
  const names = yield* fs.readDirectory(paths.threadsDir).pipe(
    Effect.catchEager((error) =>
      isNotFound(error) ? Effect.succeed([] as string[]) : Effect.fail(error),
    ),
    Effect.mapError(toRegistryError("failed to list the threads directory", "list")),
  );
  return yield* Effect.forEach(
    names,
    (name) => {
      if (!THREAD_DIR_RE.test(name)) return Effect.succeed(undefined);
      return Effect.gen(function* () {
        const content = yield* fs
          .readFileString(paths.threadFile(name))
          .pipe(Effect.catchEager(() => Effect.succeed("")));
        return yield* Effect.try({
          try: () => DECODE_THREAD_RECORD(content),
          catch: toRegistryError(`failed to read thread record ${name}`, "list"),
        }).pipe(Effect.catchEager(() => Effect.succeed(undefined)));
      });
    },
  );
});

/** Index loaded records; every thread starts idle (hosts derive the rest on touch). */
const indexLoaded = (
  loaded: readonly (ThreadRecord | undefined)[],
) => {
  const records = new Map<string, ThreadRecord>();
  const states = new Map<string, ThreadState>();
  for (const record of loaded) {
    if (record === undefined) continue;
    // Records written before auto-title (ADR 0006) have no nameAuto field.
    records.set(record.id, { ...record, nameAuto: record.nameAuto === true });
    states.set(record.id, "idle");
  }
  return { records, states };
};

/**
 * The live registry: loaded from disk when the layer is built. Every
 * mutation persists before it is visible, so a crash never leaves a record
 * that is not on disk.
 */
export const ThreadRegistryLive: Layer.Layer<
  ThreadRegistry,
  RegistryError,
  FileSystem.FileSystem | Paths
> = Layer.effect(
  ThreadRegistry,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Paths;
    const { records, states } = indexLoaded(yield* loadRecords(fs, paths));
      const recordsRef = yield* Ref.make<ReadonlyMap<string, ThreadRecord>>(records);
      const statesRef = yield* Ref.make<ReadonlyMap<string, ThreadState>>(states);

      return ThreadRegistry.of({
        list: () =>
          Ref.get(recordsRef).pipe(
            Effect.map((records) =>
              [...records.values()].sort((a, b) => a.createdAt - b.createdAt),
            ),
          ),
        get: (threadId) =>
          Ref.get(recordsRef).pipe(
            Effect.map((records) => Option.fromNullishOr(records.get(threadId))),
          ),
        create: Effect.fn("create")(function* (input) {
          const record: ThreadRecord = {
            id: crypto.randomUUID().replaceAll("-", ""),
            name: input.name,
            cwd:
              input.cwd ??
              (globalThis as { process?: { cwd?: () => string } }).process?.cwd?.() ??
              "/",
            mode: input.mode ?? "local",
            createdAt: Date.now(),
            sessionId: null,
            nameAuto: input.autoName === true,
            ...(input.source === undefined ? {} : { source: input.source }),
          };
          yield* persist(fs, paths, record);
          yield* Ref.update(recordsRef, (records) => new Map(records).set(record.id, record));
          yield* Ref.update(statesRef, (states) => new Map(states).set(record.id, "idle"));
          return record;
        }),
        update: Effect.fn("update")(function* (threadId, patch) {
          const record = yield* Ref.get(recordsRef).pipe(
            Effect.map((records) => records.get(threadId)),
          );
          if (record === undefined) return Option.none();
          const next: ThreadRecord = { ...record, ...patch };
          yield* persist(fs, paths, next);
          yield* Ref.update(recordsRef, (records) => new Map(records).set(threadId, next));
          return Option.some(next);
        }),
        setState: (threadId, state) =>
          Ref.update(statesRef, (states) => new Map(states).set(threadId, state)),
        delete: Effect.fn("delete")(function* (threadId) {
          const records = yield* Ref.get(recordsRef);
          if (!records.has(threadId)) return false;
          yield* Ref.update(recordsRef, (records) => {
            const next = new Map(records);
            next.delete(threadId);
            return next;
          });
          yield* Ref.update(statesRef, (states) => {
            const next = new Map(states);
            next.delete(threadId);
            return next;
          });
          // Best-effort removal; the registry entry is gone either way.
          yield* fs
            .remove(paths.threadDir(threadId), { recursive: true, force: true })
            .pipe(Effect.catchEager(() => Effect.void));
          return true;
        }),
        toInfo: Effect.fn("toInfo")(function* (threadId, tailSeq) {
          const record = yield* Ref.get(recordsRef).pipe(
            Effect.map((records) => records.get(threadId)),
          );
          if (record === undefined) return Option.none();
          const state = yield* Ref.get(statesRef).pipe(
            Effect.map((states) => states.get(threadId) ?? "idle"),
          );
          return Option.some({
            id: record.id,
            name: record.name,
            cwd: record.cwd,
            mode: record.mode,
            state,
            // The local daemon is the env for local threads; the hub derives
            // the real env states (stopped/provisioning/ready/error) for Boxes.
            env: "ready",
            sessionId: record.sessionId,
            tailSeq,
            ...(record.source === undefined ? {} : { source: record.source }),
          });
        }),
      });
    }),
  );

/**
 * The test registry: the live registry over `PathsTest`'s temp layout
 * (pass `home` to pin one layout across boots, e.g. the round-trip test).
 * Tests provide this plus a FileSystem layer — a fresh, isolated registry
 * per run, no env mutation.
 */
export const ThreadRegistryTest = (
  home?: string,
) =>
  ThreadRegistryLive.pipe(Layer.provide(PathsTest(home)));
