/**
 * Registry (registry.ts): the durable list of threads — the layer pi lacks
 * (a pi session has no name, no working directory, no hands policy, no
 * lifecycle state). The daemon's in-memory view, persisted as one JSON
 * record per thread on the `KvStore` seam (the same boundary the session
 * trail uses — Durable Object storage in production, files in the local
 * spine): keys `threads/<id>/thread.json` under the threads root, via the
 * `jsonRecords` layer at prefix `""`.
 *
 * Provided as a service (`ThreadRegistryLive`) so the daemon's command
 * handlers compose it with the catalog; missing records are `Option.none`,
 * storage defects die on the seam (error channel `never` — the shape keeps
 * its `RegistryError` channel, but the layer no longer produces it).
 */

import { Context, Effect, FileSystem, Layer, Option, Ref } from "effect";
import { ThreadMode, type ThreadInfo, type ThreadSource, type ThreadState } from "@saku/wire";

import { jsonRecords, KvStore } from "@saku/store";
import { Paths, PathsTest } from "./paths.ts";
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
  /** Archive a thread: visibility-only, the trail is untouched (CONTEXT.md: Archive). */
  readonly archive: (threadId: string) => Effect.Effect<Option.Option<ThreadRecord>, RegistryError>;
  /** Unarchive a thread: back to the active list, nothing else changes. */
  readonly unarchive: (threadId: string) => Effect.Effect<Option.Option<ThreadRecord>, RegistryError>;
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

/**
 * Record-shaped keys under the registry root: exactly one file per thread,
 * `threads/<id>/thread.json`. The per-thread trail stores (`trail/`
 * subdirectories) live under the same root and are not records.
 */
const THREAD_RECORD_RE = /^[0-9a-f]{32}\/thread\.json$/u;

/** The daemon's working directory (node; the DO passes cwd explicitly). */
const cwdOf = () => {
  const g = globalThis as { process?: { cwd?: () => string } };
  return g.process?.cwd?.();
};

/** Index loaded records; every thread starts idle (hosts derive the rest on touch). */
const indexLoaded = (loaded: readonly ThreadRecord[]) => {
  const records = new Map<string, ThreadRecord>();
  const states = new Map<string, ThreadState>();
  for (const record of loaded) {
    // Records written before auto-title (ADR 0006) have no nameAuto field;
    // records written before archive have no archivedAt (the schema's
    // optionalWith default fills null, this normalizes belt-and-braces).
    records.set(record.id, {
      ...record,
      nameAuto: record.nameAuto === true,
      archivedAt: record.archivedAt ?? null,
    });
    states.set(record.id, "idle");
  }
  return { records, states };
};

/**
 * The registry's store: a file-backed KvStore rooted at the threads dir.
 * Provided at the boundary (the daemon's layer composition and the test
 * registry); the registry itself only ever sees the `KvStore` service.
 * `KvStore.file` writes atomically (tmp + rename), so the temp-file dance
 * of the old FileSystem persist is the backend's job now.
 */
export const RegistryKvLive = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Paths;
    return KvStore.file(fs, paths.threadsDir);
  }),
);

/**
 * The live registry: loaded from the store when the layer is built. Every
 * mutation persists before it is visible, so a crash never leaves a record
 * that is not on disk. Requires the `KvStore` service — the daemon and the
 * tests provide the backend layer at the boundary.
 */
export const ThreadRegistryLive = Layer.effect(
  ThreadRegistry,
  Effect.gen(function* () {
    const kv = yield* KvStore;
    const paths = yield* Paths;
    const fs = yield* FileSystem.FileSystem;
    const records = jsonRecords<ThreadRecord>(kv, "");
    // Boot load: every file under the threads root is listed (and decoded
    // by the layer — corrupt files are skipped with a logWarning), then
    // filtered to record-shaped keys. A missing threads dir reads as an
    // empty registry (the file backend answers [] on a missing root).
    const loaded = yield* records
      .list()
      .pipe(
        Effect.map((entries) =>
          entries.filter(({ key }) => THREAD_RECORD_RE.test(key)).map(({ value }) => value),
        ),
      );
    const { records: initial, states: initialStates } = indexLoaded(loaded);
    const recordsRef = yield* Ref.make<ReadonlyMap<string, ThreadRecord>>(initial);
    const statesRef = yield* Ref.make<ReadonlyMap<string, ThreadState>>(initialStates);

    return ThreadRegistry.of({
      list: () =>
        Ref.get(recordsRef).pipe(
          Effect.map((records) => [...records.values()].sort((a, b) => a.createdAt - b.createdAt)),
        ),
      get: (threadId) =>
        Ref.get(recordsRef).pipe(
          Effect.map((records) => Option.fromNullishOr(records.get(threadId))),
        ),
      create: Effect.fn("create")(function* (input) {
        const record: ThreadRecord = {
          id: crypto.randomUUID().replaceAll("-", ""),
          name: input.name,
          cwd: input.cwd ?? cwdOf() ?? "/",
          mode: input.mode ?? "local",
          createdAt: Date.now(),
          sessionId: null,
          nameAuto: input.autoName === true,
          archivedAt: null,
          ...(input.source === undefined ? {} : { source: input.source }),
        };
        yield* records.put(`${record.id}/thread.json`, record);
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
        yield* records.put(`${threadId}/thread.json`, next);
        yield* Ref.update(recordsRef, (records) => new Map(records).set(threadId, next));
        return Option.some(next);
      }),
      archive: Effect.fn("archive")(function* (threadId) {
        const record = yield* Ref.get(recordsRef).pipe(
          Effect.map((records) => records.get(threadId)),
        );
        if (record === undefined) return Option.none();
        const next: ThreadRecord = { ...record, archivedAt: Date.now() };
        yield* records.put(`${threadId}/thread.json`, next);
        yield* Ref.update(recordsRef, (records) => new Map(records).set(threadId, next));
        return Option.some(next);
      }),
      unarchive: Effect.fn("unarchive")(function* (threadId) {
        const record = yield* Ref.get(recordsRef).pipe(
          Effect.map((records) => records.get(threadId)),
        );
        if (record === undefined) return Option.none();
        const next: ThreadRecord = { ...record, archivedAt: null };
        yield* records.put(`${threadId}/thread.json`, next);
        yield* Ref.update(recordsRef, (records) => new Map(records).set(threadId, next));
        return Option.some(next);
      }),
      setState: (threadId, state) =>
        Ref.update(statesRef, (states) => new Map(states).set(threadId, state)),
      delete: Effect.fn("delete")(function* (threadId) {
        const current = yield* Ref.get(recordsRef);
        if (!current.has(threadId)) return false;
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
        yield* records.delete(`${threadId}/thread.json`);
        // Best-effort removal of the thread's directory (sessions included);
        // the registry entry is gone either way.
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
          archivedAt: record.archivedAt ?? null,
        });
      }),
    });
  }),
);

/**
 * The test registry: the live registry over `PathsTest`'s temp layout
 * (pass `home` to pin one layout across boots, e.g. the round-trip test).
 * Tests provide this plus a FileSystem layer — a fresh, isolated registry
 * per run, no env mutation. (`RegistryKvLive` is provided before `PathsTest`
 * so one Paths instance satisfies both the registry and its store.)
 */
export const ThreadRegistryTest = (home?: string) =>
  ThreadRegistryLive.pipe(Layer.provide(RegistryKvLive), Layer.provide(PathsTest(home)));
