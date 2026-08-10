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

import { randomUUID } from "node:crypto";
import { Context, Effect, FileSystem, Layer, Option, Ref, Schema } from "effect";
import type { ThreadInfo, ThreadMode, ThreadState } from "@saku/wire";

import { isNotFound } from "./fs.ts";
import { getThreadDir, getThreadFile } from "./paths.ts";

export interface ThreadRecord {
  /** Full uuid (unhyphenated). Consoles see an 8-char prefix. */
  id: string;
  name: string;
  cwd: string;
  /** Hands policy, pinned at creation. */
  mode: ThreadMode;
  createdAt: number;
  /** Pi session id, stable across daemon restarts; set on first touch. */
  sessionId: string | null;
  /** The name is an auto-generated prompt snippet awaiting auto-title (CONTEXT.md: Quick start, Auto-title). */
  nameAuto: boolean;
}

/** A failed registry operation (persist, load, delete on disk). */
export class RegistryError extends Schema.TaggedError<RegistryError>()("RegistryError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export interface ThreadRegistryShape {
  readonly list: () => Effect.Effect<readonly ThreadRecord[], RegistryError>;
  readonly get: (threadId: string) => Effect.Effect<Option.Option<ThreadRecord>, RegistryError>;
  readonly create: (input: {
    name: string;
    cwd: string;
    mode?: ThreadMode;
    autoName?: boolean;
  }) => Effect.Effect<ThreadRecord, RegistryError>;
  readonly update: (
    threadId: string,
    patch: Partial<Pick<ThreadRecord, "name" | "sessionId" | "nameAuto">>,
  ) => Effect.Effect<Option.Option<ThreadRecord>, RegistryError>;
  /** Liveness state derived by hosts; not persisted (re-derived at boot). */
  readonly setState: (threadId: string, state: ThreadState) => Effect.Effect<void, never>;
  /** Delete the record AND the thread's directory (sessions included). */
  readonly delete: (threadId: string) => Effect.Effect<boolean, RegistryError>;
  /** Wire projection: registry view + derived state. */
  readonly toInfo: (threadId: string, tailSeq: number) => Effect.Effect<Option.Option<ThreadInfo>, never>;
}

/** The durable thread index. Consoles only ever see it through the wire. */
export class ThreadRegistry extends Context.Service<ThreadRegistry, ThreadRegistryShape>()("ThreadRegistry") {}

const THREAD_DIR_RE = /^[0-9a-f]{32}$/u;

const toRegistryError = (message: string) => (error: unknown): RegistryError =>
  new RegistryError({ message, cause: error });

/** Write one record atomically (temp file + rename). */
const persist = (fs: FileSystem.FileSystem, record: ThreadRecord): Effect.Effect<void, RegistryError> =>
  Effect.gen(function* () {
    yield* fs
      .makeDirectory(getThreadDir(record.id), { recursive: true })
      .pipe(Effect.mapError(toRegistryError(`failed to persist thread ${record.id}`)));
    const path = getThreadFile(record.id);
    const tmp = `${path}.tmp`;
    yield* fs
      .writeFileString(tmp, `${JSON.stringify(record, null, 2)}\n`)
      .pipe(Effect.mapError(toRegistryError(`failed to persist thread ${record.id}`)));
    yield* fs.rename(tmp, path).pipe(Effect.mapError(toRegistryError(`failed to persist thread ${record.id}`)));
  });

/**
 * Scan the threads directory. A thread with no record file was never touched;
 * corrupt records are skipped (the directory stays on disk).
 */
const loadRecords = (
  fs: FileSystem.FileSystem,
): Effect.Effect<readonly (ThreadRecord | undefined)[], RegistryError> =>
  Effect.gen(function* () {
    const names = yield* fs.readDirectory(getThreadDir("")).pipe(
      Effect.catchEager((error) => (isNotFound(error) ? Effect.succeed([] as string[]) : Effect.fail(error))),
      Effect.mapError(toRegistryError("failed to list the threads directory")),
    );
    return yield* Effect.forEach(names, (name): Effect.Effect<ThreadRecord | undefined, RegistryError> => {
      if (!THREAD_DIR_RE.test(name)) return Effect.succeed(undefined);
      return Effect.gen(function* () {
        const content = yield* fs
          .readFileString(getThreadFile(name))
          .pipe(Effect.catchEager(() => Effect.succeed("")));
        return yield* Effect.try({
          try: () => JSON.parse(content) as ThreadRecord,
          catch: toRegistryError(`failed to read thread record ${name}`),
        }).pipe(Effect.catchEager(() => Effect.succeed(undefined)));
      });
    });
  });

/** Index loaded records; every thread starts idle (hosts derive the rest on touch). */
const indexLoaded = (loaded: readonly (ThreadRecord | undefined)[]): {
  records: Map<string, ThreadRecord>;
  states: Map<string, ThreadState>;
} => {
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
export const ThreadRegistryLive: Layer.Layer<ThreadRegistry, RegistryError, FileSystem.FileSystem> = Layer.effect(
  ThreadRegistry,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { records, states } = indexLoaded(yield* loadRecords(fs));
    const recordsRef = yield* Ref.make<ReadonlyMap<string, ThreadRecord>>(records);
    const statesRef = yield* Ref.make<ReadonlyMap<string, ThreadState>>(states);

    return ThreadRegistry.of({
      list: () =>
        Ref.get(recordsRef).pipe(Effect.map((records) => [...records.values()].sort((a, b) => a.createdAt - b.createdAt))),
      get: (threadId) => Ref.get(recordsRef).pipe(Effect.map((records) => Option.fromNullishOr(records.get(threadId)))),
      create: (input) =>
        Effect.gen(function* () {
          const record: ThreadRecord = {
            id: randomUUID().replaceAll("-", ""),
            name: input.name,
            cwd: input.cwd,
            mode: input.mode ?? "local",
            createdAt: Date.now(),
            sessionId: null,
            nameAuto: input.autoName === true,
          };
          yield* persist(fs, record);
          yield* Ref.update(recordsRef, (records) => new Map(records).set(record.id, record));
          yield* Ref.update(statesRef, (states) => new Map(states).set(record.id, "idle"));
          return record;
        }),
      update: (threadId, patch) =>
        Effect.gen(function* () {
          const record = yield* Ref.get(recordsRef).pipe(Effect.map((records) => records.get(threadId)));
          if (record === undefined) return Option.none();
          const next: ThreadRecord = { ...record, ...patch };
          yield* persist(fs, next);
          yield* Ref.update(recordsRef, (records) => new Map(records).set(threadId, next));
          return Option.some(next);
        }),
      setState: (threadId, state) => Ref.update(statesRef, (states) => new Map(states).set(threadId, state)),
      delete: (threadId) =>
        Effect.gen(function* () {
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
            .remove(getThreadDir(threadId), { recursive: true, force: true })
            .pipe(Effect.catchEager(() => Effect.void));
          return true;
        }),
      toInfo: (threadId, tailSeq) =>
        Effect.gen(function* () {
          const record = yield* Ref.get(recordsRef).pipe(Effect.map((records) => records.get(threadId)));
          if (record === undefined) return Option.none();
          const state = yield* Ref.get(statesRef).pipe(Effect.map((states) => states.get(threadId) ?? "idle"));
          return Option.some({
            id: record.id,
            name: record.name,
            cwd: record.cwd,
            mode: record.mode,
            state,
            sessionId: record.sessionId,
            tailSeq,
          });
        }),
    });
  }),
);
