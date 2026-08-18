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
import type { ThreadInfo, ThreadMode, ThreadSource, ThreadState } from "@saku/wire";

import { jsonRecords, KvStore } from "@saku/store";
import { Paths, PathsTest } from "./paths.ts";
import type { RegistryError } from "./registry-error.ts";
import type { ThreadRecord } from "./registry-record.ts";

export { ThreadRecordSchema, type ThreadRecord } from "./registry-record.ts";

/**
 * The host's registry view: the narrow slice of the registry a
 * `SessionHost` drives (get/update/setState). The thread DO implements
 * exactly this; the daemon adapts its full registry over it. Hosts never
 * create/delete threads or project wire info — the hub/daemon own those.
 */
export interface HostRegistryApi {
  readonly get: (threadId: string) => Effect.Effect<Option.Option<ThreadRecord>, RegistryError>;
  readonly update: (
    threadId: string,
    patch: Partial<Pick<ThreadRecord, "name" | "sessionId" | "nameAuto">>,
  ) => Effect.Effect<Option.Option<ThreadRecord>, RegistryError>;
  /** Liveness state derived by hosts; not persisted (re-derived at boot). */
  readonly setState: (threadId: string, state: ThreadState) => Effect.Effect<void>;
}

export interface ThreadRegistryApi extends HostRegistryApi {
  readonly list: () => Effect.Effect<readonly ThreadRecord[], RegistryError>;
  readonly create: (input: {
    name: string;
    /** Defaults to the daemon's working directory (local-only semantics, ADR 0003). */
    cwd?: string;
    mode?: ThreadMode;
    autoName?: boolean;
    /** Adoption provenance for imported pi sessions (pi-sessions). */
    source?: ThreadSource;
  }) => Effect.Effect<ThreadRecord, RegistryError>;
  /** Archive a thread: visibility-only, the trail is untouched (CONTEXT.md: Archive). */
  readonly archive: (threadId: string) => Effect.Effect<Option.Option<ThreadRecord>, RegistryError>;
  /** Unarchive a thread: back to the active list, nothing else changes. */
  readonly unarchive: (
    threadId: string,
  ) => Effect.Effect<Option.Option<ThreadRecord>, RegistryError>;
  /** Delete the record AND the thread's directory (sessions included). */
  readonly delete: (threadId: string) => Effect.Effect<boolean, RegistryError>;
  /** Wire projection: registry view + derived state. */
  readonly toInfo: (threadId: string, tailSeq: number) => Effect.Effect<Option.Option<ThreadInfo>>;
}

/** The durable thread index. Consoles only ever see it through the wire. */
export class ThreadRegistry extends Context.Service<ThreadRegistry, ThreadRegistryApi>()(
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
  // SAFETY: node's globalThis exposes process.cwd; the optional access
  // pattern keeps this shape safe in non-node hosts.
  const g = globalThis as { process?: { cwd?: () => string } };
  return g.process?.cwd?.();
};

/** Attach adoption provenance when the record was imported (the `source` field is optional). */
const withRecordSource = (base: Omit<ThreadRecord, "source">, source: ThreadSource | undefined) =>
  source === undefined ? base : { ...base, source };

/** Attach adoption provenance when the wire info was projected (the `source` field is optional). */
const withInfoSource = (base: Omit<ThreadInfo, "source">, source: ThreadSource | undefined) =>
  source === undefined ? base : { ...base, source };

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
      archivedAt: record.archivedAt ?? null,
      nameAuto: record.nameAuto,
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
    const recordsStore = jsonRecords<ThreadRecord>(kv, "");
    // Boot load: every file under the threads root is listed (and decoded
    // by the layer — corrupt files are skipped with a logWarning), then
    // filtered to record-shaped keys. A missing threads dir reads as an
    // empty registry (the file backend answers [] on a missing root).
    const loaded = yield* recordsStore
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
      archive: Effect.fn("archive")(function* (threadId) {
        const record = yield* Ref.get(recordsRef).pipe(
          Effect.map((records) => records.get(threadId)),
        );
        if (record === undefined) {
          return Option.none();
        }
        const next: ThreadRecord = { ...record, archivedAt: Date.now() };
        yield* recordsStore.put(`${threadId}/thread.json`, next);
        yield* Ref.update(recordsRef, (records) => new Map(records).set(threadId, next));
        return Option.some(next);
      }),
      create: Effect.fn("create")(function* (input) {
        const record = withRecordSource(
          {
            archivedAt: null,
            createdAt: Date.now(),
            cwd: input.cwd ?? cwdOf() ?? "/",
            id: crypto.randomUUID().replaceAll("-", ""),
            mode: input.mode ?? "local",
            name: input.name,
            nameAuto: input.autoName === true,
            sessionId: null,
          },
          input.source,
        );
        yield* recordsStore.put(`${record.id}/thread.json`, record);
        yield* Ref.update(recordsRef, (records) => new Map(records).set(record.id, record));
        yield* Ref.update(statesRef, (states) => new Map(states).set(record.id, "idle"));
        return record;
      }),
      delete: Effect.fn("delete")(function* (threadId) {
        const current = yield* Ref.get(recordsRef);
        if (!current.has(threadId)) {
          return false;
        }
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
        yield* recordsStore.delete(`${threadId}/thread.json`);
        // Best-effort removal of the thread's directory (sessions included);
        // the registry entry is gone either way.
        yield* fs
          .remove(paths.threadDir(threadId), { force: true, recursive: true })
          .pipe(Effect.catchEager(() => Effect.void));
        return true;
      }),
      get: (threadId) =>
        Ref.get(recordsRef).pipe(
          Effect.map((records) => Option.fromNullishOr(records.get(threadId))),
        ),
      list: () =>
        Ref.get(recordsRef).pipe(
          Effect.map((records) =>
            [...records.values()].toSorted((a, b) => a.createdAt - b.createdAt),
          ),
        ),
      setState: (threadId, state) =>
        Ref.update(statesRef, (states) => new Map(states).set(threadId, state)),
      toInfo: Effect.fn("toInfo")(function* (threadId, tailSeq) {
        const record = yield* Ref.get(recordsRef).pipe(
          Effect.map((records) => records.get(threadId)),
        );
        if (record === undefined) {
          return Option.none();
        }
        const state = yield* Ref.get(statesRef).pipe(
          Effect.map((states) => states.get(threadId) ?? "idle"),
        );
        const info = withInfoSource(
          {
            archivedAt: record.archivedAt ?? null,
            cwd: record.cwd,
            // The local daemon is the env for local threads; the hub derives
            // the real env states (stopped/provisioning/ready/error) for Boxes.
            env: "ready",
            id: record.id,
            mode: record.mode,
            name: record.name,
            sessionId: record.sessionId,
            state,
            tailSeq,
          },
          record.source,
        );
        return Option.some(info);
      }),
      unarchive: Effect.fn("unarchive")(function* (threadId) {
        const record = yield* Ref.get(recordsRef).pipe(
          Effect.map((records) => records.get(threadId)),
        );
        if (record === undefined) {
          return Option.none();
        }
        const next: ThreadRecord = { ...record, archivedAt: null };
        yield* recordsStore.put(`${threadId}/thread.json`, next);
        yield* Ref.update(recordsRef, (records) => new Map(records).set(threadId, next));
        return Option.some(next);
      }),
      update: Effect.fn("update")(function* (threadId, patch) {
        const record = yield* Ref.get(recordsRef).pipe(
          Effect.map((records) => records.get(threadId)),
        );
        if (record === undefined) {
          return Option.none();
        }
        const next: ThreadRecord = { ...record, ...patch };
        yield* recordsStore.put(`${threadId}/thread.json`, next);
        yield* Ref.update(recordsRef, (records) => new Map(records).set(threadId, next));
        return Option.some(next);
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
