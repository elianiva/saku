/**
 * DO session storage (do-session.ts): pi's `SessionStorage`/`SessionRepo`
 * implemented over the `KvStore` seam — the swap-in for `JsonlSessionRepo`
 * that lets the same worker code run on a Durable Object (Cloudflare/celld)
 * or on a local file store (ADR 0001).
 *
 * Layout under one KvStore (per thread), through the record layer
 * (`jsonRecords`, see packages/store/src/records.ts) scoped to `session/<id>/`:
 *
 * ```
 * meta                     session metadata (created first, atomically)
 * log/<seq>                one mutation per key, seq = the log sequence
 * ```
 *
 * Records are JSON-encoded (`JSON.stringify + "\n"`, the store's encoding);
 * existing trails written as bare JSON (no trailing newline) still decode,
 * and every key write is atomic (see kv.ts), so a crash leaves a prefix of
 * the log — replay never sees a torn mutation, and there is no torn-tail
 * repair to do (unlike the jsonl backend). Writes are serialized through a
 * semaphore, mirroring `JsonlSessionStorage`, because the sequence numbers
 * must be assigned in log order.
 *
 * The KvStore seam is effect-based; this file is pi's promise seam, so each
 * mutation method crosses once with `Effect.runPromise` at this boundary.
 */

import { SessionError } from "@earendil-works/pi-agent-core";
import type {
  BranchBounds,
  Entry,
  EntryQuery,
  ForkOptions,
  LaneRecord,
  LogOptions,
  NewRecord,
  ProvisionedEntry,
  RecordQuery,
  SessionMetadata,
  SessionStorage,
} from "@earendil-works/pi-agent-core";

import { DateTime, Effect, Match, Option, Semaphore } from "effect";

import { buildEntry, buildRecord } from "./session-schemas.ts";

import { jsonRecords, LogKey, SessionPrefix } from "@saku/store";
import type { KvStoreApi, RecordCollection } from "@saku/store";
import { SessionState } from "./session-state.ts";
import type { SessionMutation } from "./session-state.ts";

export interface DoSessionMetadata extends SessionMetadata {
  readonly cwd: string;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;

export const validateSessionId = (id: string) =>
  Match.value(id).pipe(
    Match.when(
      (v) => !SESSION_ID_PATTERN.test(v),
      () =>
        Effect.fail(
          new SessionError(
            "invalid_payload",
            "Session id must be non-empty, contain only alphanumeric characters, '-', '_', and '.', and start and end with an alphanumeric character",
          ),
        ),
    ),
    Match.orElse(() => Effect.void),
  );

const MUTATION_KINDS = new Set(["entry", "record", "lane", "fact"]);

/**
 * Validate one replayed log entry. The collection owns the single decode
 * (JSON.parse — corrupt entries never reach this gate, the layer skips them
 * with a logWarning), so this validates the decoded shape: an entry that is
 * not a session mutation still fails the load loudly, like the storage
 * error the raw decode used to raise.
 */
/** Whether a decoded log value is a session mutation (kind in the vocabulary). */
const isMutation = (value: SessionMutation): value is SessionMutation =>
  typeof value === "object" &&
  value !== null &&
  "kind" in value &&
  typeof value.kind === "string" &&
  MUTATION_KINDS.has(value.kind);

/** The log sequence of a mutation (the entry/record carry theirs). */
export const mutationSeq = (mutation: SessionMutation) => {
  if (mutation.kind === "entry") {
    return mutation.entry.seq;
  }
  if (mutation.kind === "record") {
    return mutation.record.seq;
  }
  return mutation.seq;
};

/** Validate one replayed log entry (corrupt shapes fail the load loudly). */
const parseMutation = (key: string, value: SessionMutation) => {
  if (!isMutation(value)) {
    return Effect.fail(new SessionError("storage", `Invalid session mutation at ${key}`));
  }
  return Effect.succeed(value);
};

/**
 * One session's storage over a KvStore. Mutations are appended in log order
 * (semaphore), then applied to the in-memory `SessionState`, exactly like
 * pi's jsonl storage — only the persistence medium differs.
 */
export class DoSessionStorage implements SessionStorage<DoSessionMetadata> {
  private readonly log: RecordCollection<SessionMutation>;
  private readonly metadata: DoSessionMetadata;
  private readonly state: SessionState;
  /** Serializes mutations so sequence numbers are assigned in log order. */
  private readonly semaphore = Semaphore.makeUnsafe(1);

  /** Internal: build via `create`/`load`/the repo. */
  constructor(kv: KvStoreApi, metadata: DoSessionMetadata, state: SessionState) {
    this.log = jsonRecords<SessionMutation>(kv, SessionPrefix.create(metadata.id));
    this.metadata = metadata;
    this.state = state;
  }

  /** Create a fresh session: metadata first, then an empty log. */
  static create(kv: KvStoreApi, metadata: DoSessionMetadata) {
    return Effect.gen(function* () {
      yield* jsonRecords<DoSessionMetadata>(kv, SessionPrefix.create(metadata.id)).put(
        "meta",
        metadata,
      );
      return new DoSessionStorage(kv, metadata, new SessionState());
    });
  }

  /** Load a session by replaying its log. */
  static load(kv: KvStoreApi, id: string) {
    return Effect.gen(function* () {
      const prefix = SessionPrefix.create(id);
      const metaValue = yield* jsonRecords<DoSessionMetadata>(kv, prefix).get("meta");
      // Missing OR corrupt metadata both read as "no record" on the layer,
      // so either answers the not-found error (a corrupt meta no longer
      // escapes as a JSON.parse defect).
      if (Option.isNone(metaValue)) {
        return yield* Effect.fail(new SessionError("not_found", `Session not found: ${id}`));
      }
      const metadata = metaValue.value;
      if (metadata.id !== id) {
        return yield* Effect.fail(
          new SessionError("invalid_entry", `Session id does not match metadata: ${id}`),
        );
      }
      const state = new SessionState();
      const loaded = yield* jsonRecords<SessionMutation>(kv, prefix).list();
      // The collection spans the whole session prefix (meta + log/*); replay
      // wants only the log entries. Keys arrive as `log/<seq>` — the last
      // path segment is the zero-padded sequence. The file backend's readdir
      // order is not sorted, so the sequence is the only order.
      const mutations = loaded
        .filter(({ key }) => key.startsWith("log/"))
        .toSorted(
          (a, b) =>
            Number(a.key.slice(a.key.lastIndexOf("/") + 1)) -
            Number(b.key.slice(b.key.lastIndexOf("/") + 1)),
        );
      for (const { key, value } of mutations) {
        const parsed = yield* parseMutation(key, value);
        state.applyMutation(parsed);
      }
      return new DoSessionStorage(kv, metadata, state);
    });
  }

  async getMetadata() {
    return structuredClone(this.metadata);
  }

  async getLanes() {
    return this.state.getLanes();
  }

  async createLane(lane: string, at: string | null) {
    await this.mutate(() =>
      Effect.gen({ self: this }, function* () {
        this.state.validateNewLane(lane);
        this.state.validateTarget(at);
        const mutation: SessionMutation = {
          kind: "lane",
          lane,
          leafId: at,
          seq: this.state.nextSequence,
        };
        yield* this.appendMutation(mutation);
        this.state.applyMutation(mutation);
      }),
    );
  }

  async moveLane(lane: string, to: string | null) {
    await this.mutate(() =>
      Effect.gen({ self: this }, function* () {
        this.state.requireLane(lane);
        this.state.validateTarget(to);
        const mutation: SessionMutation = {
          kind: "lane",
          lane,
          leafId: to,
          seq: this.state.nextSequence,
        };
        yield* this.appendMutation(mutation);
        this.state.applyMutation(mutation);
      }),
    );
  }

  async appendEntry<TEntry extends Entry>(newEntry: ProvisionedEntry<TEntry>, lane: string) {
    return await this.mutate(() =>
      Effect.gen({ self: this }, function* () {
        const parentId = this.state.requireLane(lane);
        this.state.validateUnusedId(newEntry.id);
        const now = yield* DateTime.now;
        const entry = buildEntry(
          structuredClone(newEntry),
          parentId,
          this.state.nextSequence,
          DateTime.toEpochMillis(now),
        );
        const mutation: SessionMutation = { entry, kind: "entry", lane };
        yield* this.appendMutation(mutation);
        this.state.applyMutation(mutation);
        return structuredClone(entry);
      }),
    );
  }

  async appendRecord<TRecord extends LaneRecord>(newRecord: NewRecord<TRecord>) {
    return await this.mutate(() =>
      Effect.gen({ self: this }, function* () {
        this.state.requireLane(newRecord.lane);
        this.state.validateUnusedId(newRecord.id);
        const currentOpenOperationId = this.state.findOpenOperations(newRecord.lane, {
          limit: 1,
        })[0]?.id;
        if (newRecord.type === "operation_started" && currentOpenOperationId !== undefined) {
          return yield* Effect.fail(
            new SessionError(
              "storage",
              `Lane ${newRecord.lane} already has an open operation ${currentOpenOperationId}`,
            ),
          );
        }
        const now = yield* DateTime.now;
        const record = buildRecord(
          structuredClone(newRecord),
          this.state.nextSequence,
          DateTime.toEpochMillis(now),
        );
        const mutation: SessionMutation = { kind: "record", record };
        yield* this.appendMutation(mutation);
        this.state.applyMutation(mutation);
        return structuredClone(record);
      }),
    );
  }

  async getEntry(id: string) {
    const entry = this.state.getEntry(id);
    return entry === undefined ? undefined : structuredClone(entry);
  }

  async findEntries(query: EntryQuery = {}) {
    return structuredClone(this.state.findEntries(query));
  }

  async findEntriesOnBranch(query: EntryQuery & BranchBounds & { start: string }) {
    return structuredClone(this.state.findEntriesOnBranch(query));
  }

  async findRecords<K extends LaneRecord["type"]>(
    query: RecordQuery & { type: K },
  ): Promise<Extract<LaneRecord, { type: K }>[]>;
  async findRecords(query?: RecordQuery): Promise<LaneRecord[]>;
  async findRecords(query: RecordQuery = {}) {
    return structuredClone(this.state.findRecords(query));
  }

  async findOpenOperations(lane: string, options?: { limit?: number }) {
    return structuredClone(this.state.findOpenOperations(lane, options));
  }

  async getLog(options: LogOptions = {}) {
    return structuredClone(this.state.getLog(options));
  }

  async getName() {
    return this.state.getName();
  }

  async setName(name: string) {
    await this.mutate(() =>
      Effect.gen({ self: this }, function* () {
        const mutation: SessionMutation = {
          fact: "name",
          kind: "fact",
          name,
          seq: this.state.nextSequence,
        };
        yield* this.appendMutation(mutation);
        this.state.applyMutation(mutation);
      }),
    );
  }

  async getLabel(id: string) {
    return this.state.getLabel(id);
  }

  async setLabel(id: string, label: string | undefined) {
    await this.mutate(() =>
      Effect.gen({ self: this }, function* () {
        this.state.validateTarget(id);
        const mutation: SessionMutation = {
          fact: "label",
          kind: "fact",
          label,
          seq: this.state.nextSequence,
          targetId: id,
        };
        yield* this.appendMutation(mutation);
        this.state.applyMutation(mutation);
      }),
    );
  }

  async getStats() {
    return structuredClone(this.state.getStats());
  }

  /** Fork mutations for this session (repo-level `fork`). */
  forkMutations(options: ForkOptions) {
    return this.state.createForkMutations(options);
  }

  /** Replay pre-built mutations (fork children). */
  applyMutations(mutations: readonly SessionMutation[]) {
    for (const mutation of mutations) {
      this.state.applyMutation(mutation);
    }
  }

  /** Run a mutation body under the write semaphore; the only promise crossing. */
  private mutate<A, E>(body: () => Effect.Effect<A, E>) {
    return Effect.runPromise(this.semaphore.withPermit(Effect.suspend(body)));
  }

  /** Append one mutation to the log (a plain kv write — the semaphore orders them). */
  appendMutation(mutation: SessionMutation) {
    return this.log.put(LogKey.create(mutationSeq(mutation)), mutation);
  }
}
