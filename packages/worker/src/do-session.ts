/**
 * DO session storage (do-session.ts): pi's `SessionStorage`/`SessionRepo`
 * implemented over the `KvStore` seam — the swap-in for `JsonlSessionRepo`
 * that lets the same worker code run on a Durable Object (Cloudflare/celld)
 * or on a local file store (ADR 0001).
 *
 * Layout under one KvStore (per thread):
 *
 * ```
 * session/<id>/meta          session metadata (created first, atomically)
 * session/<id>/log/<seq>     one mutation per key, seq = the log sequence
 * ```
 *
 * Every key write is atomic (see kv.ts), so a crash leaves a prefix of the
 * log — replay never sees a torn mutation, and there is no torn-tail repair
 * to do (unlike the jsonl backend). Writes are serialized through a promise
 * tail, mirroring `JsonlSessionStorage`, because the sequence numbers must
 * be assigned in log order.
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

import { Effect } from "effect";

import type { KvStoreShape } from "@saku/store";
import { type SessionMutation, SessionState } from "./session-state.ts";

export interface DoSessionMetadata extends SessionMetadata {
  readonly cwd: string;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

const validateSessionId = (id: string): void => {
  if (!SESSION_ID_PATTERN.test(id)) {
    throw new SessionError(
      "invalid_payload",
      "Session id must be non-empty, contain only alphanumeric characters, '-', '_', and '.', and start and end with an alphanumeric character",
    );
  }
};

const encode = (value: string | Uint8Array): Uint8Array =>
  typeof value === "string" ? new TextEncoder().encode(value) : value;

const decode = (value: Uint8Array): string => new TextDecoder().decode(value);

/** The key prefix that owns one session's keys. */
const sessionPrefix = (id: string): string => `session/${id}/`;

/** Zero-padded so `list` ordering and manual inspection agree with seq order. */
const logKey = (seq: number): string => `log/${String(seq).padStart(12, "0")}`;

const parseMutation = (key: string, value: Uint8Array): SessionMutation => {
  try {
    const parsed: unknown = JSON.parse(decode(value));
    return parsed as SessionMutation;
  } catch (error) {
    throw new SessionError(
      "storage",
      `Invalid session mutation at ${key}: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? error : undefined,
    );
  }
};

/** A KvStore scoped to one session's key prefix. */
const prefixedKv = (kv: KvStoreShape, prefix: string): KvStoreShape => ({
  get: (key) => kv.get(`${prefix}${key}`),
  put: (key, value) => kv.put(`${prefix}${key}`, value),
  delete: (key) => kv.delete(`${prefix}${key}`),
  list: ({ prefix: subPrefix }) => kv.list({ prefix: `${prefix}${subPrefix}` }),
});

/**
 * One session's storage over a KvStore. Mutations are appended in log order
 * (promise tail), then applied to the in-memory `SessionState`, exactly like
 * pi's jsonl storage — only the persistence medium differs.
 */
export class DoSessionStorage implements SessionStorage<DoSessionMetadata> {
  private readonly kv: KvStoreShape;
  private readonly metadata: DoSessionMetadata;
  private readonly state: SessionState;
  /** Serializes mutations so sequence numbers are assigned in log order. */
  private tail: Promise<unknown> = Promise.resolve();

  /** Internal: build via `create`/`load`/the repo. */
  constructor(kv: KvStoreShape, metadata: DoSessionMetadata, state: SessionState) {
    this.kv = kv;
    this.metadata = metadata;
    this.state = state;
  }

  /** Create a fresh session: metadata first, then an empty log. */
  static async create(kv: KvStoreShape, metadata: DoSessionMetadata): Promise<DoSessionStorage> {
    await Effect.runPromise(kv.put("meta", encode(JSON.stringify(metadata))));
    return new DoSessionStorage(kv, metadata, new SessionState());
  }

  /** Load a session by replaying its log. */
  static async load(kv: KvStoreShape, id: string): Promise<DoSessionStorage> {
    const metaValue = await Effect.runPromise(kv.get("meta"));
    if (metaValue === undefined) {
      throw new SessionError("not_found", `Session not found: ${id}`);
    }
    const metadata = JSON.parse(decode(metaValue)) as DoSessionMetadata;
    if (metadata.id !== id) {
      throw new SessionError("invalid_entry", `Session id does not match metadata: ${id}`);
    }
    const state = new SessionState();
    const loaded = await Effect.runPromise(kv.list({ prefix: "log/" }));
    const mutations = [...loaded].sort((a, b) => Number(a.key.slice(4)) - Number(b.key.slice(4)));
    for (const mutation of mutations) {
      state.applyMutation(parseMutation(mutation.key, mutation.value));
    }
    return new DoSessionStorage(kv, metadata, state);
  }

  async getMetadata(): Promise<DoSessionMetadata> {
    return structuredClone(this.metadata);
  }

  getLanes(): Promise<LanePointer[]> {
    return Promise.resolve(this.state.getLanes());
  }

  createLane(lane: string, at: string | null): Promise<void> {
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

  moveLane(lane: string, to: string | null): Promise<void> {
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

  appendEntry<TEntry extends Entry>(
    newEntry: ProvisionedEntry<TEntry>,
    lane: string,
  ): Promise<TEntry> {
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

  appendRecord<TRecord extends LaneRecord>(newRecord: NewRecord<TRecord>): Promise<TRecord> {
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

  async getEntry(id: string): Promise<Entry | undefined> {
    const entry = this.state.getEntry(id);
    return entry === undefined ? undefined : structuredClone(entry);
  }

  async findEntries(query: EntryQuery = {}): Promise<Entry[]> {
    return structuredClone(this.state.findEntries(query));
  }

  async findEntriesOnBranch(
    query: EntryQuery & BranchBounds & { start: string },
  ): Promise<Entry[]> {
    return structuredClone(this.state.findEntriesOnBranch(query));
  }

  async findRecords<K extends LaneRecord["type"]>(
    query: RecordQuery & { type: K },
  ): Promise<Extract<LaneRecord, { type: K }>[]>;
  async findRecords(query?: RecordQuery): Promise<LaneRecord[]>;
  async findRecords(query: RecordQuery = {}): Promise<LaneRecord[]> {
    return structuredClone(this.state.findRecords(query));
  }

  async findOpenOperations(
    lane: string,
    options?: { limit?: number },
  ): Promise<OperationStartedRecord[]> {
    return structuredClone(this.state.findOpenOperations(lane, options));
  }

  async getLog(options: LogOptions = {}): Promise<LogItem[]> {
    return structuredClone(this.state.getLog(options));
  }

  async getName(): Promise<string | undefined> {
    return this.state.getName();
  }

  setName(name: string): Promise<void> {
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

  async getLabel(id: string): Promise<string | undefined> {
    return this.state.getLabel(id);
  }

  setLabel(id: string, label: string | undefined): Promise<void> {
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

  async getStats(): Promise<SessionStats> {
    return structuredClone(this.state.getStats());
  }

  /** Fork mutations for this session (repo-level `fork`). */
  forkMutations(options: ForkOptions): SessionMutation[] {
    return this.state.createForkMutations(options);
  }

  /** Replay pre-built mutations (fork children). */
  applyMutations(mutations: readonly SessionMutation[]): void {
    for (const mutation of mutations) {
      this.state.applyMutation(mutation);
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Serialize one mutation to the log (ordered through the tail). */
  async appendMutation(mutation: SessionMutation): Promise<void> {
    await Effect.runPromise(
      this.kv.put(logKey(mutationSeq(mutation)), encode(JSON.stringify(mutation))),
    );
  }
}

const mutationSeq = (mutation: SessionMutation): number =>
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

  async create(options: SessionCreateOptions = {}): Promise<Session<DoSessionMetadata>> {
    const id = options.id ?? crypto.randomUUID().replaceAll("-", "");
    validateSessionId(id);
    const prefix = sessionPrefix(id);
    if ((await Effect.runPromise(this.kv.get(`${prefix}meta`))) !== undefined) {
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
    const storage = await DoSessionStorage.create(prefixedKv(this.kv, prefix), metadata);
    return new Session(storage);
  }

  async open(metadata: DoSessionMetadata): Promise<Session<DoSessionMetadata>> {
    return new Session(
      await DoSessionStorage.load(prefixedKv(this.kv, sessionPrefix(metadata.id)), metadata.id),
    );
  }

  async list(): Promise<DoSessionMetadata[]> {
    const entries = await Effect.runPromise(this.kv.list({ prefix: "session/" }));
    const all: DoSessionMetadata[] = [];
    for (const entry of entries) {
      if (entry.key.endsWith("/meta")) {
        all.push(JSON.parse(decode(entry.value)) as DoSessionMetadata);
      }
    }
    return all.sort((a, b) => b.createdAt - a.createdAt);
  }

  async delete(metadata: DoSessionMetadata): Promise<void> {
    const prefix = sessionPrefix(metadata.id);
    const keys = await Effect.runPromise(this.kv.list({ prefix }));
    for (const entry of keys) {
      await Effect.runPromise(this.kv.delete(entry.key));
    }
  }

  async fork(
    source: DoSessionMetadata,
    options: ForkOptions & SessionCreateOptions,
  ): Promise<Session<DoSessionMetadata>> {
    const sourceStorage = await DoSessionStorage.load(
      prefixedKv(this.kv, sessionPrefix(source.id)),
      source.id,
    );
    const childId = options.id ?? crypto.randomUUID().replaceAll("-", "");
    validateSessionId(childId);
    const childPrefix = sessionPrefix(childId);
    if ((await Effect.runPromise(this.kv.get(`${childPrefix}meta`))) !== undefined) {
      throw new SessionError("already_exists", `Session already exists: ${childId}`);
    }
    const metadata: DoSessionMetadata = {
      id: childId,
      createdAt: Date.now(),
      cwd: "",
      // Forks default their parent to the source session (jsonl parity).
      parentSessionId: options.parentSessionId ?? source.id,
    };
    await Effect.runPromise(this.kv.put(`${childPrefix}meta`, encode(JSON.stringify(metadata))));
    const mutations = sourceStorage.forkMutations(options);
    const childStorage = new DoSessionStorage(
      prefixedKv(this.kv, childPrefix),
      metadata,
      new SessionState(),
    );
    for (const mutation of mutations) {
      await childStorage.appendMutation(mutation);
      childStorage.applyMutations([mutation]);
    }
    return new Session(childStorage);
  }
}
