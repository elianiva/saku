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
 * promise tail, mirroring `JsonlSessionStorage`, because the sequence
 * numbers must be assigned in log order.
 *
 * The KvStore seam is effect-based; this file is pi's promise seam, so each
 * kv call crosses once with `Effect.runPromise` at this boundary.
 */

import {
  Session,
  SessionError,
  type BranchBounds,
  type Entry,
  type EntryQuery,
  type ForkOptions,
  type LanePointer,
  type LaneRecord,
  type LogItem,
  type LogOptions,
  type NewRecord,
  type OperationStartedRecord,
  type ProvisionedEntry,
  type RecordQuery,
  type SessionCreateOptions,
  type SessionMetadata,
  type SessionRepo,
  type SessionStats,
  type SessionStorage,
} from "@earendil-works/pi-agent-core";

import { Effect, Option } from "effect";

import { jsonRecords, type KvStoreShape, type RecordCollection } from "@saku/store";
import { type SessionMutation, SessionState } from "./session-state.ts";

export interface DoSessionMetadata extends SessionMetadata {
  readonly cwd: string;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

const validateSessionId = (id: string) => {
  if (!SESSION_ID_PATTERN.test(id)) {
    throw new SessionError(
      "invalid_payload",
      "Session id must be non-empty, contain only alphanumeric characters, '-', '_', and '.', and start and end with an alphanumeric character",
    );
  }
};

/** The key prefix that owns one session's keys. */
const sessionPrefix = (id: string) => `session/${id}/`;

/** Zero-padded so `list` ordering and manual inspection agree with seq order. */
const logKey = (seq: number) => `log/${String(seq).padStart(12, "0")}`;

const MUTATION_KINDS = new Set(["entry", "record", "lane", "fact"]);

/**
 * Validate one replayed log entry. The collection owns the single decode
 * (JSON.parse — corrupt entries never reach this gate, the layer skips them
 * with a logWarning), so this validates the decoded shape: an entry that is
 * not a session mutation still fails the load loudly, like the storage
 * error the raw decode used to raise.
 */
const parseMutation = (key: string, value: unknown) => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("kind" in value) ||
    typeof value.kind !== "string" ||
    !MUTATION_KINDS.has(value.kind)
  ) {
    throw new SessionError("storage", `Invalid session mutation at ${key}`);
  }
  return value as SessionMutation;
};

/**
 * One session's storage over a KvStore. Mutations are appended in log order
 * (promise tail), then applied to the in-memory `SessionState`, exactly like
 * pi's jsonl storage — only the persistence medium differs.
 */
export class DoSessionStorage implements SessionStorage<DoSessionMetadata> {
  private readonly log: RecordCollection<unknown>;
  private readonly metadata: DoSessionMetadata;
  private readonly state: SessionState;
  /** Serializes mutations so sequence numbers are assigned in log order. */
  private tail: Promise<unknown> = Promise.resolve();

  /** Internal: build via `create`/`load`/the repo. */
  constructor(kv: KvStoreShape, metadata: DoSessionMetadata, state: SessionState) {
    this.log = jsonRecords<unknown>(kv, sessionPrefix(metadata.id));
    this.metadata = metadata;
    this.state = state;
  }

  /** Create a fresh session: metadata first, then an empty log. */
  static async create(kv: KvStoreShape, metadata: DoSessionMetadata) {
    await Effect.runPromise(
      jsonRecords<DoSessionMetadata>(kv, sessionPrefix(metadata.id)).put("meta", metadata),
    );
    return new DoSessionStorage(kv, metadata, new SessionState());
  }

  /** Load a session by replaying its log. */
  static async load(kv: KvStoreShape, id: string) {
    const prefix = sessionPrefix(id);
    const metaValue = await Effect.runPromise(
      jsonRecords<DoSessionMetadata>(kv, prefix).get("meta"),
    );
    // Missing OR corrupt metadata both read as "no record" on the layer,
    // so either answers the not-found error (a corrupt meta no longer
    // escapes as a JSON.parse defect).
    if (Option.isNone(metaValue)) {
      throw new SessionError("not_found", `Session not found: ${id}`);
    }
    const metadata = metaValue.value;
    if (metadata.id !== id) {
      throw new SessionError("invalid_entry", `Session id does not match metadata: ${id}`);
    }
    const state = new SessionState();
    const loaded = await Effect.runPromise(jsonRecords<unknown>(kv, prefix).list());
    // The collection spans the whole session prefix (meta + log/*); replay
    // wants only the log entries. Keys arrive as `log/<seq>` — the last
    // path segment is the zero-padded sequence. The file backend's readdir
    // order is not sorted, so the sequence is the only order.
    const mutations = loaded
      .filter(({ key }) => key.startsWith("log/"))
      .sort(
        (a, b) =>
          Number(a.key.slice(a.key.lastIndexOf("/") + 1)) -
          Number(b.key.slice(b.key.lastIndexOf("/") + 1)),
      );
    for (const mutation of mutations) {
      state.applyMutation(parseMutation(mutation.key, mutation.value));
    }
    return new DoSessionStorage(kv, metadata, state);
  }

  async getMetadata() {
    return structuredClone(this.metadata);
  }

  getLanes() {
    return Promise.resolve(this.state.getLanes());
  }

  createLane(lane: string, at: string | null) {
    return this.enqueue(async () => {
      this.state.validateNewLane(lane);
      this.state.validateTarget(at);
      const mutation: SessionMutation = {
        kind: "lane",
        seq: this.state.nextSequence,
        lane,
        leafId: at,
      };
      await this.appendMutation(mutation);
      this.state.applyMutation(mutation);
    });
  }

  moveLane(lane: string, to: string | null) {
    return this.enqueue(async () => {
      this.state.requireLane(lane);
      this.state.validateTarget(to);
      const mutation: SessionMutation = {
        kind: "lane",
        seq: this.state.nextSequence,
        lane,
        leafId: to,
      };
      await this.appendMutation(mutation);
      this.state.applyMutation(mutation);
    });
  }

  appendEntry<TEntry extends Entry>(newEntry: ProvisionedEntry<TEntry>, lane: string) {
    return this.enqueue(async () => {
      const parentId = this.state.requireLane(lane);
      this.state.validateUnusedId(newEntry.id);
      const entry = {
        ...structuredClone(newEntry),
        parentId,
        seq: this.state.nextSequence,
        timestamp: Date.now(),
      } as unknown as TEntry;
      const mutation: SessionMutation = { kind: "entry", lane, entry };
      await this.appendMutation(mutation);
      this.state.applyMutation(mutation);
      return structuredClone(entry);
    });
  }

  appendRecord<TRecord extends LaneRecord>(newRecord: NewRecord<TRecord>) {
    return this.enqueue(async () => {
      this.state.requireLane(newRecord.lane);
      this.state.validateUnusedId(newRecord.id);
      const currentOpenOperationId = this.state.findOpenOperations(newRecord.lane, { limit: 1 })[0]
        ?.id;
      if (newRecord.type === "operation_started" && currentOpenOperationId !== undefined) {
        throw new SessionError(
          "storage",
          `Lane ${newRecord.lane} already has an open operation ${currentOpenOperationId}`,
        );
      }
      const record = {
        ...structuredClone(newRecord),
        seq: this.state.nextSequence,
        timestamp: Date.now(),
      } as unknown as TRecord;
      const mutation: SessionMutation = { kind: "record", record };
      await this.appendMutation(mutation);
      this.state.applyMutation(mutation);
      return structuredClone(record);
    });
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

  setName(name: string) {
    return this.enqueue(async () => {
      const mutation: SessionMutation = {
        kind: "fact",
        seq: this.state.nextSequence,
        fact: "name",
        name,
      };
      await this.appendMutation(mutation);
      this.state.applyMutation(mutation);
    });
  }

  async getLabel(id: string) {
    return this.state.getLabel(id);
  }

  setLabel(id: string, label: string | undefined) {
    return this.enqueue(async () => {
      this.state.validateTarget(id);
      const mutation: SessionMutation = {
        kind: "fact",
        seq: this.state.nextSequence,
        fact: "label",
        targetId: id,
        label,
      };
      await this.appendMutation(mutation);
      this.state.applyMutation(mutation);
    });
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

  private enqueue<T>(operation: () => Promise<T>) {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Serialize one mutation to the log (ordered through the tail). */
  async appendMutation(mutation: SessionMutation) {
    await Effect.runPromise(this.log.put(logKey(mutationSeq(mutation)), mutation));
  }
}

const mutationSeq = (mutation: SessionMutation) =>
  mutation.kind === "entry"
    ? mutation.entry.seq
    : mutation.kind === "record"
      ? mutation.record.seq
      : mutation.seq;

/**
 * The repo over one KvStore (one thread's namespace). Sessions live flat
 * under `session/<id>/`, so forked children coexist with the thread's own
 * session, and pi's conformance suite passes against this backend.
 */
export class DoSessionRepo implements SessionRepo<DoSessionMetadata> {
  private readonly kv: KvStoreShape;

  constructor(kv: KvStoreShape) {
    this.kv = kv;
  }

  async create(options: SessionCreateOptions = {}) {
    const id = options.id ?? crypto.randomUUID().replaceAll("-", "");
    validateSessionId(id);
    const prefix = sessionPrefix(id);
    // Byte-existence check (raw kv): a corrupt meta still counts as taken,
    // so create never overwrites a foreign session's keys.
    if (Option.isSome(await Effect.runPromise(this.kv.get(`${prefix}meta`)))) {
      throw new SessionError("already_exists", `Session already exists: ${id}`);
    }
    const metadata: DoSessionMetadata = {
      id,
      createdAt: Date.now(),
      cwd: "",
      ...(options.parentSessionId === undefined
        ? {}
        : { parentSessionId: options.parentSessionId }),
    };
    const storage = await DoSessionStorage.create(this.kv, metadata);
    return new Session(storage);
  }

  /**
   * Adopt a parsed pi session (pi-sessions.ts): write its mutations into
   * this repo as a fresh session, then load it back — the load replays the
   * whole log through `SessionState`, so an invalid import (broken chain,
   * duplicate id, non-consecutive seq) fails here, before a thread points
   * at it. The session id must be the thread's own id: the host looks up
   * the trail by thread id (session-host.ts).
   */
  async import(
    id: string,
    data: {
      readonly cwd: string;
      readonly createdAt: number;
      readonly mutations: readonly SessionMutation[];
    },
  ) {
    validateSessionId(id);
    const prefix = sessionPrefix(id);
    if (Option.isSome(await Effect.runPromise(this.kv.get(`${prefix}meta`)))) {
      throw new SessionError("already_exists", `Session already exists: ${id}`);
    }
    const metadata: DoSessionMetadata = { id, createdAt: data.createdAt, cwd: data.cwd };
    const meta = jsonRecords<DoSessionMetadata>(this.kv, prefix);
    await Effect.runPromise(meta.put("meta", metadata));
    const log = jsonRecords<unknown>(this.kv, prefix);
    for (const mutation of data.mutations) {
      await Effect.runPromise(log.put(logKey(mutationSeq(mutation)), mutation));
    }
    return this.open(metadata);
  }

  async open(metadata: DoSessionMetadata) {
    return new Session(await DoSessionStorage.load(this.kv, metadata.id));
  }

  async list() {
    const sessions = jsonRecords<DoSessionMetadata>(this.kv, "session/");
    const entries = await Effect.runPromise(sessions.list());
    return entries
      .filter(({ key }) => key.endsWith("/meta"))
      .map(({ value }) => value)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async delete(metadata: DoSessionMetadata) {
    const prefix = sessionPrefix(metadata.id);
    const keys = await Effect.runPromise(this.kv.list({ prefix }));
    for (const entry of keys) {
      await Effect.runPromise(this.kv.delete(entry.key));
    }
  }

  async fork(source: DoSessionMetadata, options: ForkOptions & SessionCreateOptions) {
    const sourceStorage = await DoSessionStorage.load(this.kv, source.id);
    const childId = options.id ?? crypto.randomUUID().replaceAll("-", "");
    validateSessionId(childId);
    const childPrefix = sessionPrefix(childId);
    if (Option.isSome(await Effect.runPromise(this.kv.get(`${childPrefix}meta`)))) {
      throw new SessionError("already_exists", `Session already exists: ${childId}`);
    }
    const metadata: DoSessionMetadata = {
      id: childId,
      createdAt: Date.now(),
      cwd: "",
      // Forks default their parent to the source session (jsonl parity).
      parentSessionId: options.parentSessionId ?? source.id,
    };
    await Effect.runPromise(
      jsonRecords<DoSessionMetadata>(this.kv, childPrefix).put("meta", metadata),
    );
    const mutations = sourceStorage.forkMutations(options);
    const childStorage = new DoSessionStorage(this.kv, metadata, new SessionState());
    for (const mutation of mutations) {
      await childStorage.appendMutation(mutation);
      childStorage.applyMutations([mutation]);
    }
    return new Session(childStorage);
  }
}
