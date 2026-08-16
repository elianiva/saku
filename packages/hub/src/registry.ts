/**
 * The hub's registry (registry.ts): the durable thread index — the
 * control-plane record the wire's `ThreadInfo` is projected from.
 *
 * Lives on the `KvStore` seam (the same durability boundary the worker's
 * session trail uses — Durable Object storage in production, memory or
 * files in tests and the local spine), so the hub runs identically inside a
 * DO and in-process. Keys: `threads/<id>/record` (one JSON record, via the
 * `jsonRecords` layer at prefix `"threads/"`).
 *
 * What is persisted vs. derived:
 *
 * - persisted: name, cwd, mode, autoName, createdAt, sessionId, env —
 *   a stopped Box must stay stopped across hub restarts (ADR 0003)
 * - volatile caches (re-derived from worker events and command results):
 *   `state` (idle/working/interrupted, pushed by the worker) and `tailSeq`
 *   (the thread's durable-log sequence, reported by the worker)
 *
 * Consoles only ever see the registry through the wire (`toInfo`).
 */

import { Context, Effect, Option, Ref } from "effect";
import type { EnvHandle } from "@saku/env";
import type { ThreadEnvState, ThreadInfo, ThreadMode, ThreadState } from "@saku/wire";

import type { HubError } from "./hub-error.ts";
import { jsonRecords, KvStore } from "@saku/store";

/** The hub's registry record; `ThreadInfo` is its wire projection. */
export interface HubRecord {
  /** Full uuid (unhyphenated). Consoles see an 8-char prefix. */
  id: string;
  name: string;
  /** The local working directory; null for sandbox threads (ADR 0003). */
  cwd: string | null;
  /** Hands policy, pinned at creation. */
  mode: ThreadMode;
  /** The name is an auto-generated prompt snippet awaiting auto-title (CONTEXT.md: Quick start). */
  autoName: boolean;
  createdAt: number;
  /** Pi session id, stable across hub restarts; set on first touch. */
  sessionId: string | null;
  /** The env axis: persisted, because it outlives processes (idle-stop). */
  env: ThreadEnvState;
  /** The persisted env handle (url + token + box id); null before provisioning. */
  envHandle: EnvHandle | null;
  /** Archive visibility lifecycle (CONTEXT.md: Archive); null when active. */
  archivedAt: number | null;
}

export interface HubRegistryApi {
  readonly list: () => Effect.Effect<readonly HubRecord[], HubError>;
  readonly get: (threadId: string) => Effect.Effect<Option.Option<HubRecord>, HubError>;
  readonly create: (input: {
    name: string;
    cwd?: string;
    mode?: ThreadMode;
    autoName?: boolean;
  }) => Effect.Effect<HubRecord, HubError>;
  readonly update: (
    threadId: string,
    patch: Partial<Pick<HubRecord, "name" | "sessionId" | "autoName" | "archivedAt">>,
  ) => Effect.Effect<Option.Option<HubRecord>, HubError>;
  /** Persist the env axis (stopped → provisioning → ready → error). */
  readonly setEnv: (
    threadId: string,
    env: ThreadEnvState,
  ) => Effect.Effect<Option.Option<HubRecord>, HubError>;
  /** Persist the env handle (survives hub restarts: a stopped Box stays stopped). */
  readonly setEnvHandle: (
    threadId: string,
    handle: EnvHandle | null,
  ) => Effect.Effect<Option.Option<HubRecord>, HubError>;
  /** Volatile lifecycle state, pushed by the worker (not persisted). */
  readonly setState: (threadId: string, state: ThreadState) => Effect.Effect<void>;
  /** Volatile durable-log sequence, reported by the worker (not persisted). */
  readonly setTailSeq: (threadId: string, tailSeq: number) => Effect.Effect<void>;
  /** Delete the record; the thread's session trail is the worker's to remove. */
  readonly delete: (threadId: string) => Effect.Effect<boolean, HubError>;
  /** Wire projection: registry view + derived caches. */
  readonly toInfo: (threadId: string) => Effect.Effect<Option.Option<ThreadInfo>, HubError>;
}

/** The live registry: loaded from the store when built, persisted on every
 * mutation. Requires the `KvStore` service — the DO adapter and the tests
 * provide the backend layer at the boundary. */
export class HubRegistry extends Context.Service<HubRegistry, HubRegistryApi>()("HubRegistry", {
  make: Effect.fn("HubRegistry.make")(function* make(): Effect.fn.Return<
    HubRegistryApi,
    HubError,
    KvStore
  > {
    const kv = yield* KvStore;
    const records = jsonRecords<HubRecord>(kv, "threads/");
    const loaded = yield* records.list();
    const recordsRef = yield* Ref.make<ReadonlyMap<string, HubRecord>>(
      new Map(loaded.map(({ value }) => [value.id, value])),
    );
    const statesRef = yield* Ref.make<ReadonlyMap<string, ThreadState>>(
      new Map(loaded.map(({ value }) => [value.id, "idle"])),
    );
    const tailSeqsRef = yield* Ref.make<ReadonlyMap<string, number>>(new Map());

    const patch = Effect.fn("patch")(function* patch(
      threadId: string,
      fn: (record: HubRecord) => HubRecord,
    ) {
      const current = yield* Ref.get(recordsRef);
      const record = current.get(threadId);
      if (record === undefined) {
        return Option.none();
      }
      const next = fn(record);
      yield* records.put(`${next.id}/record`, next);
      yield* Ref.update(recordsRef, (map) => new Map(map).set(threadId, next));
      return Option.some(next);
    });

    return {
      create: Effect.fn("create")(function* create(input) {
        const record: HubRecord = {
          archivedAt: null,
          autoName: input.autoName === true,
          createdAt: Date.now(),
          // Sandbox threads have no local directory (ADR 0003); local
          // threads default to none until the env daemon reports one.
          cwd: input.mode === "sandbox" ? null : (input.cwd ?? null),
          // A Box is not provisioned until the first prompt (lazy, ADR 0003).
          env: input.mode === "sandbox" ? "stopped" : "ready",
          envHandle: null,
          id: crypto.randomUUID().replaceAll("-", ""),
          mode: input.mode ?? "local",
          name: input.name,
          sessionId: null,
        };
        yield* records.put(`${record.id}/record`, record);
        yield* Ref.update(recordsRef, (map) => new Map(map).set(record.id, record));
        yield* Ref.update(statesRef, (map) => new Map(map).set(record.id, "idle"));
        yield* Ref.update(tailSeqsRef, (map) => new Map(map).set(record.id, 0));
        return record;
      }),
      delete: Effect.fn("delete")(function* deleteRecord(threadId) {
        const current = yield* Ref.get(recordsRef);
        if (!current.has(threadId)) {
          return false;
        }
        yield* Ref.update(recordsRef, (map) => {
          const next = new Map(map);
          next.delete(threadId);
          return next;
        });
        yield* Ref.update(statesRef, (map) => {
          const next = new Map(map);
          next.delete(threadId);
          return next;
        });
        yield* Ref.update(tailSeqsRef, (map) => {
          const next = new Map(map);
          next.delete(threadId);
          return next;
        });
        yield* records.delete(`${threadId}/record`);
        return true;
      }),
      get: (threadId) =>
        Ref.get(recordsRef).pipe(Effect.map((map) => Option.fromNullishOr(map.get(threadId)))),
      list: () =>
        Ref.get(recordsRef).pipe(
          Effect.map((map) => [...map.values()].toSorted((a, b) => a.createdAt - b.createdAt)),
        ),
      setEnv: (threadId, env) => patch(threadId, (record) => ({ ...record, env })),
      setEnvHandle: (threadId, envHandle) =>
        patch(threadId, (record) => ({ ...record, envHandle })),
      setState: (threadId, state) =>
        Ref.update(statesRef, (states) => new Map(states).set(threadId, state)),
      setTailSeq: (threadId, tailSeq) =>
        Ref.update(tailSeqsRef, (tailSeqs) => new Map(tailSeqs).set(threadId, tailSeq)),
      toInfo: Effect.fn("toInfo")(function* toInfo(threadId) {
        const record = yield* Ref.get(recordsRef).pipe(Effect.map((map) => map.get(threadId)));
        if (record === undefined) {
          return Option.none();
        }
        const [state, tailSeq] = yield* Effect.all([
          Ref.get(statesRef).pipe(Effect.map((states) => states.get(threadId) ?? "idle")),
          Ref.get(tailSeqsRef).pipe(Effect.map((tailSeqs) => tailSeqs.get(threadId) ?? 0)),
        ]);
        return Option.some({
          archivedAt: record.archivedAt ?? null,
          cwd: record.cwd,
          env: record.env,
          id: record.id,
          mode: record.mode,
          name: record.name,
          sessionId: record.sessionId,
          state,
          tailSeq,
        } satisfies ThreadInfo);
      }),
      update: (threadId, patch_) => patch(threadId, (record) => ({ ...record, ...patch_ })),
    };
  }),
}) {}
