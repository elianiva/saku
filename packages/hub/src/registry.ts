/**
 * The hub's registry (registry.ts): the durable thread index — the
 * control-plane record the wire's `ThreadInfo` is projected from.
 *
 * Lives on the `KvStore` seam (the same durability boundary the worker's
 * session trail uses — Durable Object storage in production, memory or
 * files in tests and the local spine), so the hub runs identically inside a
 * DO and in-process. Keys: `threads/<id>/record` (one JSON record).
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

import { Effect, Option, Ref } from "effect";
import type { EnvHandle } from "@saku/env";
import type { ThreadEnvState, ThreadInfo, ThreadMode, ThreadState } from "@saku/wire";

import { HubError } from "./hub-error.ts";
import { KvStore, type KvStoreShape } from "@saku/store";

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
}

export interface HubRegistryShape {
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
    patch: Partial<Pick<HubRecord, "name" | "sessionId" | "autoName">>,
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
  readonly setState: (threadId: string, state: ThreadState) => Effect.Effect<void, never>;
  /** Volatile durable-log sequence, reported by the worker (not persisted). */
  readonly setTailSeq: (threadId: string, tailSeq: number) => Effect.Effect<void, never>;
  /** Delete the record; the thread's session trail is the worker's to remove. */
  readonly delete: (threadId: string) => Effect.Effect<boolean, HubError>;
  /** Wire projection: registry view + derived caches. */
  readonly toInfo: (threadId: string) => Effect.Effect<Option.Option<ThreadInfo>, HubError>;
}

const recordKey = (threadId: string): string => `threads/${threadId}/record`;

const encodeRecord = (record: HubRecord): Uint8Array =>
  new TextEncoder().encode(`${JSON.stringify(record)}\n`);

const decodeRecord = (value: Uint8Array): HubRecord =>
  JSON.parse(new TextDecoder().decode(value)) as HubRecord;

/** Persist one record; every mutation is durable before it is visible. */
const persist = (kv: KvStoreShape, record: HubRecord): Effect.Effect<void, never> =>
  kv.put(recordKey(record.id), encodeRecord(record));

/** Load every record at build time; corrupt records are skipped. */
const load = (kv: KvStoreShape): Effect.Effect<readonly HubRecord[], never> =>
  Effect.gen(function* () {
    const entries = yield* kv.list({ prefix: "threads/" });
    return yield* Effect.forEach(entries, (entry) =>
      Effect.try(() => decodeRecord(entry.value)).pipe(
        Effect.catch((error) =>
          // Corrupt record: skip (the key stays on disk for inspection).
          Effect.logWarning(`[hub] skipping corrupt registry record: ${String(error)}`).pipe(
            Effect.as(undefined),
          ),
        ),
      ),
    ).pipe(Effect.map((records) => records.filter((record) => record !== undefined)));
  });

/**
 * The live registry: loaded from the store when built, persisted on every
 * mutation. Requires the `KvStore` service — the DO adapter and the tests
 * provide the backend layer at the boundary.
 */
export const makeHubRegistry = (): Effect.Effect<HubRegistryShape, HubError, KvStore> =>
  Effect.gen(function* () {
    const kv = yield* KvStore;
    const loaded = yield* load(kv);
    const recordsRef = yield* Ref.make<ReadonlyMap<string, HubRecord>>(
      new Map(loaded.map((record) => [record.id, record])),
    );
    const statesRef = yield* Ref.make<ReadonlyMap<string, ThreadState>>(
      new Map(loaded.map((record) => [record.id, "idle" as ThreadState])),
    );
    const tailSeqsRef = yield* Ref.make<ReadonlyMap<string, number>>(new Map());

    const patch = (
      threadId: string,
      fn: (record: HubRecord) => HubRecord,
    ): Effect.Effect<Option.Option<HubRecord>, HubError> =>
      Effect.gen(function* () {
        const records = yield* Ref.get(recordsRef);
        const record = records.get(threadId);
        if (record === undefined) return Option.none();
        const next = fn(record);
        yield* persist(kv, next);
        yield* Ref.update(recordsRef, (records) => new Map(records).set(threadId, next));
        return Option.some(next);
      });

    return {
      list: () =>
        Ref.get(recordsRef).pipe(
          Effect.map((records) => [...records.values()].sort((a, b) => a.createdAt - b.createdAt)),
        ),
      get: (threadId) =>
        Ref.get(recordsRef).pipe(
          Effect.map((records) => Option.fromNullishOr(records.get(threadId))),
        ),
      create: (input) =>
        Effect.gen(function* () {
          const record: HubRecord = {
            id: crypto.randomUUID().replaceAll("-", ""),
            name: input.name,
            // Sandbox threads have no local directory (ADR 0003); local
            // threads default to none until the env daemon reports one.
            cwd: input.mode === "sandbox" ? null : (input.cwd ?? null),
            mode: input.mode ?? "local",
            autoName: input.autoName === true,
            createdAt: Date.now(),
            sessionId: null,
            // A Box is not provisioned until the first prompt (lazy, ADR 0003).
            env: input.mode === "sandbox" ? "stopped" : "ready",
            envHandle: null,
          };
          yield* persist(kv, record);
          yield* Ref.update(recordsRef, (records) => new Map(records).set(record.id, record));
          yield* Ref.update(statesRef, (states) => new Map(states).set(record.id, "idle"));
          yield* Ref.update(tailSeqsRef, (tailSeqs) => new Map(tailSeqs).set(record.id, 0));
          return record;
        }),
      update: (threadId, patch_) => patch(threadId, (record) => ({ ...record, ...patch_ })),
      setEnv: (threadId, env) => patch(threadId, (record) => ({ ...record, env })),
      setEnvHandle: (threadId, envHandle) =>
        patch(threadId, (record) => ({ ...record, envHandle })),
      setState: (threadId, state) =>
        Ref.update(statesRef, (states) => new Map(states).set(threadId, state)),
      setTailSeq: (threadId, tailSeq) =>
        Ref.update(tailSeqsRef, (tailSeqs) => new Map(tailSeqs).set(threadId, tailSeq)),
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
          yield* Ref.update(tailSeqsRef, (tailSeqs) => {
            const next = new Map(tailSeqs);
            next.delete(threadId);
            return next;
          });
          yield* kv.delete(recordKey(threadId));
          return true;
        }),
      toInfo: (threadId) =>
        Effect.gen(function* () {
          const record = yield* Ref.get(recordsRef).pipe(
            Effect.map((records) => records.get(threadId)),
          );
          if (record === undefined) return Option.none();
          const [state, tailSeq] = yield* Effect.all([
            Ref.get(statesRef).pipe(Effect.map((states) => states.get(threadId) ?? "idle")),
            Ref.get(tailSeqsRef).pipe(Effect.map((tailSeqs) => tailSeqs.get(threadId) ?? 0)),
          ]);
          return Option.some({
            id: record.id,
            name: record.name,
            cwd: record.cwd,
            mode: record.mode,
            state,
            env: record.env,
            sessionId: record.sessionId,
            tailSeq,
          } satisfies ThreadInfo);
        }),
    };
  });
