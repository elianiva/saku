/**
 * Session state (session-state.ts): the in-memory semantic core of a pi
 * session trail — entries, records, lanes, sequence numbers, names, labels,
 * stats — plus the mutation type that the log is made of.
 *
 * This is a faithful port of pi-agent-core's internal `SessionState` (the
 * class behind `JsonlSessionStorage` and `InMemorySessionStorage`), which pi
 * keeps private. It exists so saku's own storage backend (`DoSessionStorage`)
 * can persist the same mutation log that pi's JSONL backend writes, replay it
 * on load, and answer pi's `SessionStorage` queries with identical semantics.
 * Parity is enforced by pi's own `SessionBackendConformance` suite (see
 * test/do-session.test.ts), not by trust in the copy.
 *
 * Mutations are JSON-shaped exactly like pi's jsonl lines (kind/seq/fields),
 * so a trail written here is readable by pi's codec and vice versa.
 */

import { SessionError } from "@earendil-works/pi-agent-core";
import type {
  BranchBounds,
  Entry,
  EntryQuery,
  ForkOptions,
  LanePointer,
  LaneRecord,
  LogItem,
  LogOptions,
  OperationStartedRecord,
  RecordQuery,
  SessionStats,
} from "@earendil-works/pi-agent-core";

import { Match } from "effect";

/** One log mutation — pi's jsonl mutation vocabulary, verbatim. */
export type SessionMutation =
  | { kind: "entry"; lane?: string; entry: Entry }
  | { kind: "record"; record: LaneRecord }
  | { kind: "lane"; seq: number; lane: string; leafId: string | null }
  | { kind: "fact"; seq: number; fact: "name"; name: string }
  | { kind: "fact"; seq: number; fact: "label"; targetId: string; label: string | undefined };

/**
 * Drift guard: saku replays pi's jsonl mutation vocabulary (the mutations
 * pi's storage would have written). The `kind` sets must match
 * `LogItem`'s exactly — when pi adds or renames a mutation kind, these
 * type errors surface here instead of the copy drifting silently.
 */
type _Assert<C extends true> = C;
type _MutationKindsCovered = _Assert<
  { readonly [K in SessionMutation["kind"]]: K } extends {
    readonly [K in LogItem["kind"]]: K;
  }
    ? true
    : false
>;
type _MutationKindsExact = _Assert<
  { readonly [K in LogItem["kind"]]: K } extends {
    readonly [K in SessionMutation["kind"]]: K;
  }
    ? true
    : false
>;

/** The mutation's log sequence (the entry/record carry theirs). */
const mutationSeqOf = (mutation: SessionMutation) => {
  if (mutation.kind === "entry") {
    return mutation.entry.seq;
  }
  if (mutation.kind === "record") {
    return mutation.record.seq;
  }
  return mutation.seq;
};

const invalidMutation = (message: string) => {
  throw new SessionError("invalid_entry", `Invalid session mutation: ${message}`);
};

const assertValidLimit = (limit: number | undefined) => {
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new SessionError("invalid_query", "limit must be a positive integer");
  }
};

const assertValidCursor = (afterSeq: number | undefined) => {
  if (afterSeq !== undefined && (!Number.isInteger(afterSeq) || afterSeq < 0)) {
    throw new SessionError("invalid_query", "cursor sequence must be a non-negative integer");
  }
};

const ordered = function* ordered<T>(
  items: readonly T[],
  order: "newestFirst" | "oldestFirst" | undefined,
) {
  if (order === "oldestFirst") {
    for (const item of items) {
      yield item;
    }
    return;
  }
  for (const item of [...items].toReversed()) {
    yield item;
  }
};

/** The entry query's filter (the session state's query semantics). */
const matchesEntryQuery = (entry: Entry, query: EntryQuery) =>
  (query.type === undefined || entry.type === query.type) &&
  (query.customType === undefined ||
    (entry.type === "custom" && entry.customType === query.customType)) &&
  (query.cursor === undefined ||
    (query.order === "oldestFirst"
      ? entry.seq > query.cursor.afterSeq
      : entry.seq < query.cursor.afterSeq));

/** The record query's filter (the session state's query semantics). */
const matchesRecordQuery = (record: LaneRecord, query: RecordQuery) =>
  (query.lane === undefined || record.lane === query.lane) &&
  (query.type === undefined || record.type === query.type) &&
  (query.runId === undefined ||
    (record.type === "operation_started"
      ? record.id === query.runId
      : "runId" in record && record.runId === query.runId)) &&
  (query.operationKind === undefined ||
    (record.type === "operation_started" && record.intent.kind === query.operationKind)) &&
  (query.afterSeq === undefined || record.seq > query.afterSeq);

/** The semantic core of one session: replay mutations, answer queries. */
export class SessionState {
  private sequence = 0;
  private readonly usedIds = new Set<string>();
  private readonly entries: Entry[] = [];
  private readonly entriesById = new Map<string, Entry>();
  private readonly records: LaneRecord[] = [];
  private readonly openOperationsByLane = new Map<string, Map<string, OperationStartedRecord>>();
  private readonly lanes = new Map<string, string | null>([["main", null]]);
  private readonly log: LogItem[] = [];
  private readonly stats: SessionStats = {
    cachedTokens: 0,
    costTotal: 0,
    messageCount: 0,
    totalTokens: 0,
    uncachedTokens: 0,
  };
  private name: string | undefined;
  private readonly labels = new Map<string, string>();

  get nextSequence() {
    return this.sequence + 1;
  }

  getLanes() {
    return [...this.lanes].map(([lane, leafId]) => ({ lane, leafId }));
  }

  requireLane(lane: string) {
    const leafId = this.lanes.get(lane);
    if (leafId === undefined) {
      throw new SessionError("invalid_lane", `Lane not found: ${lane}`);
    }
    return leafId;
  }

  validateNewLane(lane: string) {
    if (this.lanes.has(lane)) {
      throw new SessionError("already_exists", `Lane already exists: ${lane}`);
    }
  }

  validateTarget(targetId: string | null) {
    if (targetId !== null && !this.entriesById.has(targetId)) {
      throw new SessionError("not_found", `Entry not found: ${targetId}`);
    }
  }

  validateUnusedId(id: string) {
    if (this.usedIds.has(id)) {
      throw new SessionError("already_exists", `Session id already exists: ${id}`);
    }
  }

  applyMutation(change: SessionMutation) {
    const seq = mutationSeqOf(change);
    if (seq !== this.sequence + 1) {
      invalidMutation(`has non-consecutive seq ${seq}`);
    }
    Match.value(change).pipe(
      Match.discriminator("kind")("entry", (mutation) => {
        if (this.usedIds.has(mutation.entry.id)) {
          invalidMutation(`contains duplicate id ${mutation.entry.id}`);
        }
        if (mutation.lane !== undefined) {
          const leafId = this.lanes.get(mutation.lane);
          if (leafId === undefined) {
            invalidMutation(`references missing lane ${mutation.lane}`);
          }
          if (mutation.entry.parentId !== leafId) {
            invalidMutation("does not chain to the lane leaf");
          }
        }
        if (mutation.entry.parentId !== null && !this.entriesById.has(mutation.entry.parentId)) {
          invalidMutation(`references missing parent ${mutation.entry.parentId}`);
        }
        this.sequence = seq;
        this.usedIds.add(mutation.entry.id);
        this.entries.push(mutation.entry);
        this.entriesById.set(mutation.entry.id, mutation.entry);
        if (mutation.lane !== undefined) {
          this.lanes.set(mutation.lane, mutation.entry.id);
        }
        this.log.push({ entry: mutation.entry, kind: "entry", seq });
        if (mutation.entry.type === "message") {
          this.stats.messageCount += 1;
        }
      }),
      Match.discriminator("kind")("record", (mutation) => {
        if (!this.lanes.has(mutation.record.lane)) {
          invalidMutation(`references missing lane ${mutation.record.lane}`);
        }
        if (this.usedIds.has(mutation.record.id)) {
          invalidMutation(`contains duplicate id ${mutation.record.id}`);
        }
        this.sequence = seq;
        this.usedIds.add(mutation.record.id);
        this.records.push(mutation.record);
        if (mutation.record.type === "operation_started") {
          let openOperations = this.openOperationsByLane.get(mutation.record.lane);
          if (openOperations === undefined) {
            openOperations = new Map();
            this.openOperationsByLane.set(mutation.record.lane, openOperations);
          }
          openOperations.set(mutation.record.id, mutation.record);
        } else if (mutation.record.type === "operation_finished") {
          this.openOperationsByLane.get(mutation.record.lane)?.delete(mutation.record.runId);
        }
        this.log.push({ kind: "record", record: mutation.record, seq });
        if (mutation.record.type === "usage") {
          this.stats.cachedTokens += mutation.record.usage.cacheRead;
          this.stats.uncachedTokens +=
            mutation.record.usage.input + mutation.record.usage.cacheWrite;
          this.stats.totalTokens += mutation.record.usage.totalTokens;
          this.stats.costTotal += mutation.record.usage.cost.total;
        }
      }),
      Match.discriminator("kind")("lane", (mutation) => {
        if (mutation.leafId !== null && !this.entriesById.has(mutation.leafId)) {
          invalidMutation(`references missing lane target ${mutation.leafId}`);
        }
        this.sequence = seq;
        this.lanes.set(mutation.lane, mutation.leafId);
        this.log.push({ kind: "lane", lane: mutation.lane, leafId: mutation.leafId, seq });
      }),
      Match.discriminator("kind")("fact", (mutation) => {
        if (mutation.fact === "label" && !this.entriesById.has(mutation.targetId)) {
          invalidMutation(`references missing label target ${mutation.targetId}`);
        }
        this.sequence = seq;
        if (mutation.fact === "name") {
          this.name = mutation.name;
          this.log.push({ fact: "name", kind: "fact", name: mutation.name, seq });
        } else {
          if (mutation.label === undefined) {
            this.labels.delete(mutation.targetId);
          } else {
            this.labels.set(mutation.targetId, mutation.label);
          }
          this.log.push({
            fact: "label",
            kind: "fact",
            label: mutation.label,
            seq,
            targetId: mutation.targetId,
          });
        }
      }),
    );
  }

  getEntry(id: string) {
    return this.entriesById.get(id);
  }

  findEntries(query: EntryQuery = {}) {
    assertValidLimit(query.limit);
    assertValidCursor(query.cursor?.afterSeq);
    const results: Entry[] = [];
    for (const entry of ordered(this.entries, query.order)) {
      if (!matchesEntryQuery(entry, query)) {
        continue;
      }
      results.push(entry);
      if (results.length === query.limit) {
        break;
      }
    }
    return results;
  }

  findEntriesOnBranch(query: EntryQuery & BranchBounds & { start: string }) {
    assertValidLimit(query.limit);
    assertValidCursor(query.cursor?.afterSeq);
    const results: Entry[] = [];
    if (query.order === "oldestFirst") {
      for (const entry of [...this.walkToRoot(query.start)].toReversed()) {
        const reachedBound = entry.id === query.stopAtId || entry.type === query.stopAtType;
        if (matchesEntryQuery(entry, query)) {
          results.push(entry);
        }
        if (reachedBound || results.length === query.limit) {
          break;
        }
      }
    } else {
      for (const entry of this.walkToRoot(query.start, query)) {
        if (matchesEntryQuery(entry, query)) {
          results.push(entry);
        }
        if (results.length === query.limit) {
          break;
        }
      }
    }
    return results;
  }

  findRecords(query: RecordQuery = {}) {
    assertValidLimit(query.limit);
    assertValidCursor(query.afterSeq);
    const results: LaneRecord[] = [];
    for (const record of ordered(this.records, query.order)) {
      if (!matchesRecordQuery(record, query)) {
        continue;
      }
      results.push(record);
      if (results.length === query.limit) {
        break;
      }
    }
    return results;
  }

  findOpenOperations(lane: string, options?: { limit?: number }) {
    assertValidLimit(options?.limit);
    const openOperationsById = this.openOperationsByLane.get(lane);
    const openOperations = openOperationsById ? [...openOperationsById.values()].toReversed() : [];
    return options?.limit === undefined ? openOperations : openOperations.slice(0, options.limit);
  }

  getLog(options: LogOptions = {}) {
    assertValidLimit(options.limit);
    assertValidCursor(options.afterSeq);
    const results: LogItem[] = [];
    for (const item of this.log) {
      if (options.afterSeq !== undefined && item.seq <= options.afterSeq) {
        continue;
      }
      results.push(item);
      if (results.length === options.limit) {
        break;
      }
    }
    return results;
  }

  getName() {
    return this.name;
  }

  getLabel(id: string) {
    return this.labels.get(id);
  }

  getStats() {
    return this.stats;
  }

  /** The mutations that copy entries/lanes/facts into a forked session. */
  createForkMutations(options: ForkOptions) {
    let copiedEntries: Entry[];
    let forkLanes: LanePointer[];
    if (options.scope === "tree") {
      copiedEntries = this.findEntries({ order: "oldestFirst" });
      forkLanes = this.getLanes();
    } else {
      const selectedEntryId = options.entryId ?? this.requireLane("main");
      let targetId: string | null = null;
      if (selectedEntryId !== null) {
        const entry = this.getEntry(selectedEntryId);
        if (entry === undefined || entry.type !== "message") {
          throw new SessionError(
            "invalid_fork_target",
            `Fork target is not a message entry: ${selectedEntryId}`,
          );
        }
        const position = options.position ?? (options.entryId === undefined ? "at" : "before");
        targetId = position === "at" ? entry.id : entry.parentId;
      }
      copiedEntries =
        targetId === null
          ? []
          : this.findEntriesOnBranch({ order: "oldestFirst", start: targetId });
      forkLanes = [{ lane: "main", leafId: targetId }];
    }
    const mutations: SessionMutation[] = [];
    // Seq starts at 1 for the first copied entry (pre-increment per mutation).
    let sequence = 0;
    for (const sourceEntry of copiedEntries) {
      sequence += 1;
      mutations.push({
        entry: { ...structuredClone(sourceEntry), seq: sequence },
        kind: "entry",
      });
    }
    for (const pointer of forkLanes) {
      sequence += 1;
      mutations.push({ kind: "lane", lane: pointer.lane, leafId: pointer.leafId, seq: sequence });
    }
    if (this.name !== undefined) {
      sequence += 1;
      mutations.push({ fact: "name", kind: "fact", name: this.name, seq: sequence });
    }
    for (const entry of copiedEntries) {
      const label = this.labels.get(entry.id);
      if (label !== undefined) {
        sequence += 1;
        mutations.push({ fact: "label", kind: "fact", label, seq: sequence, targetId: entry.id });
      }
    }
    return mutations;
  }

  private *walkToRoot(start: string, bounds?: BranchBounds) {
    if (start === null) {
      return;
    }
    const visited = new Set<string>();
    let current = this.entriesById.get(start);
    if (current === undefined) {
      throw new SessionError("not_found", `Entry not found: ${start}`);
    }
    while (current !== undefined) {
      if (visited.has(current.id)) {
        throw new SessionError("invalid_entry", `Session branch contains a cycle at ${current.id}`);
      }
      visited.add(current.id);
      yield current;
      if (
        current.id === bounds?.stopAtId ||
        current.type === bounds?.stopAtType ||
        current.parentId === null
      ) {
        break;
      }
      const { parentId } = current;
      current = this.entriesById.get(parentId);
      if (current === undefined) {
        throw new SessionError("invalid_entry", `Entry not found: ${parentId}`);
      }
    }
  }
}
