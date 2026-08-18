/**
 * Session schemas (session-schemas.ts): Effect Schema definitions for session
 * entries and records.  The schemas validate structural shape at construction
 * time — discriminants, required fields, field types — without replacing
 * pi-agent-core's own type definitions (which carry `AgentMessage`, generics,
 * and `exactOptionalPropertyTypes` nuances the schemas can't replicate).
 *
 * Deep validation of `AgentMessage` and `Usage` happens at their own creation
 * boundaries (the pi-agent-core harness).  These schemas validate presence and
 * structural shape — enough to catch missing fields and wrong discriminants at
 * the storage layer.
 */

import { Schema } from "effect";
import type { Entry, LaneRecord, NewRecord, ProvisionedEntry } from "@earendil-works/pi-agent-core";

// ── External type schemas ───────────────────────────────────────────

/** Minimal structural guard — validates presence, not the full union. */
const AgentMessage = Schema.declare<unknown>(
  (value): value is unknown => typeof value === "object" && value !== null && "role" in value,
);

const Usage = Schema.declare<unknown>(
  (value): value is unknown =>
    typeof value === "object" && value !== null && "input" in value && "output" in value,
);

// ── Shared field schemas ────────────────────────────────────────────

const Seq = Schema.Number;
const Timestamp = Schema.Number;
const ParentId = Schema.Union([Schema.Null, Schema.String]);
const Lane = Schema.String;

// ── Entry schemas (full — with storage-assigned fields) ─────────────

const MessageEntry = Schema.Struct({
  type: Schema.Literal("message"),
  id: Schema.String,
  message: AgentMessage,
  terminate: Schema.optional(Schema.Literal(true)),
  seq: Seq,
  parentId: ParentId,
  timestamp: Timestamp,
});

const ModelChangeEntry = Schema.Struct({
  type: Schema.Literal("model_change"),
  id: Schema.String,
  provider: Schema.String,
  modelId: Schema.String,
  seq: Seq,
  parentId: ParentId,
  timestamp: Timestamp,
});

const ThinkingLevelEntry = Schema.Struct({
  type: Schema.Literal("thinking_level_change"),
  id: Schema.String,
  thinkingLevel: Schema.String,
  seq: Seq,
  parentId: ParentId,
  timestamp: Timestamp,
});

const ActiveToolsEntry = Schema.Struct({
  type: Schema.Literal("active_tools_change"),
  id: Schema.String,
  activeToolNames: Schema.Array(Schema.String),
  seq: Seq,
  parentId: ParentId,
  timestamp: Timestamp,
});

const CompactionEntry = Schema.Struct({
  type: Schema.Literal("compaction"),
  id: Schema.String,
  summary: Schema.String,
  retainedTail: Schema.Array(AgentMessage),
  tokensBefore: Schema.Number,
  details: Schema.optional(Schema.Json),
  usage: Schema.optional(Usage),
  seq: Seq,
  parentId: ParentId,
  timestamp: Timestamp,
});

const BranchSummaryEntry = Schema.Struct({
  type: Schema.Literal("branch_summary"),
  id: Schema.String,
  fromId: Schema.String,
  summary: Schema.String,
  details: Schema.optional(Schema.Json),
  usage: Schema.optional(Usage),
  seq: Seq,
  parentId: ParentId,
  timestamp: Timestamp,
});

const CustomEntry = Schema.Struct({
  type: Schema.Literal("custom"),
  id: Schema.String,
  customType: Schema.String,
  data: Schema.optional(Schema.Json),
  seq: Seq,
  parentId: ParentId,
  timestamp: Timestamp,
});

export const EntrySchema = Schema.Union([
  MessageEntry,
  ModelChangeEntry,
  ThinkingLevelEntry,
  ActiveToolsEntry,
  CompactionEntry,
  BranchSummaryEntry,
  CustomEntry,
]);

// ── Lane record schemas (full — with storage-assigned fields) ───────

const OperationStartedRecord = Schema.Struct({
  type: Schema.Literal("operation_started"),
  id: Schema.String,
  lane: Lane,
  sourceLeafId: Schema.Union([Schema.Null, Schema.String]),
  intent: Schema.Json,
  seq: Schema.Number,
  timestamp: Timestamp,
});

const AbortRequestedRecord = Schema.Struct({
  type: Schema.Literal("abort_requested"),
  id: Schema.String,
  lane: Lane,
  runId: Schema.String,
  seq: Schema.Number,
  timestamp: Timestamp,
});

const OperationFinishedRecord = Schema.Struct({
  type: Schema.Literal("operation_finished"),
  id: Schema.String,
  lane: Lane,
  runId: Schema.String,
  outcome: Schema.Union([
    Schema.Literal("completed"),
    Schema.Literal("aborted"),
    Schema.Literal("failed"),
    Schema.Literal("declined"),
  ]),
  error: Schema.optional(Schema.Struct({ code: Schema.String, message: Schema.String })),
  seq: Schema.Number,
  timestamp: Timestamp,
});

const StepAttemptRecord = Schema.Struct({
  type: Schema.Literal("step_attempt"),
  id: Schema.String,
  lane: Lane,
  runId: Schema.String,
  step: Schema.Union([
    Schema.Literal("assistant"),
    Schema.Literal("branch_summary"),
    Schema.Literal("compaction"),
  ]),
  attempt: Schema.Number,
  resultEntryId: Schema.String,
  compactionReason: Schema.optional(
    Schema.Union([
      Schema.Literal("manual"),
      Schema.Literal("threshold"),
      Schema.Literal("overflow"),
    ]),
  ),
  seq: Schema.Number,
  timestamp: Timestamp,
});

const ToolStartedRecord = Schema.Struct({
  type: Schema.Literal("tool_started"),
  id: Schema.String,
  lane: Lane,
  runId: Schema.String,
  assistantEntryId: Schema.String,
  toolIndex: Schema.Number,
  toolCallId: Schema.String,
  toolName: Schema.String,
  effectiveArgs: Schema.Record(Schema.String, Schema.Json),
  resultEntryId: Schema.String,
  replay: Schema.Union([Schema.Literal("never"), Schema.Literal("safe")]),
  seq: Schema.Number,
  timestamp: Timestamp,
});

const QueueEnqueuedRecord = Schema.Struct({
  type: Schema.Literal("queue_enqueued"),
  id: Schema.String,
  lane: Lane,
  queue: Schema.Union([
    Schema.Literal("steer"),
    Schema.Literal("followUp"),
    Schema.Literal("nextRun"),
  ]),
  runId: Schema.optional(Schema.String),
  target: Schema.Json,
  seq: Schema.Number,
  timestamp: Timestamp,
});

const QueueCancelledRecord = Schema.Struct({
  type: Schema.Literal("queue_cancelled"),
  id: Schema.String,
  lane: Lane,
  runId: Schema.optional(Schema.String),
  entryId: Schema.String,
  seq: Schema.Number,
  timestamp: Timestamp,
});

const WriteDeferredRecord = Schema.Struct({
  type: Schema.Literal("write_deferred"),
  id: Schema.String,
  lane: Lane,
  runId: Schema.String,
  target: Schema.Json,
  seq: Schema.Number,
  timestamp: Timestamp,
});

const UsageRecord = Schema.Struct({
  type: Schema.Literal("usage"),
  id: Schema.String,
  lane: Lane,
  usage: Usage,
  cause: Schema.Union([
    Schema.Literal("assistant"),
    Schema.Literal("compaction"),
    Schema.Literal("branch_summary"),
    Schema.Literal("deferred_fetch"),
    Schema.Literal("tool"),
    Schema.Literal("hook"),
    Schema.Literal("adjustment"),
  ]),
  runId: Schema.optional(Schema.String),
  entryId: Schema.optional(Schema.String),
  toolCallId: Schema.optional(Schema.String),
  attempt: Schema.optional(Schema.Number),
  stopReason: Schema.optional(Schema.String),
  details: Schema.optional(Schema.Json),
  seq: Schema.Number,
  timestamp: Timestamp,
});

export const LaneRecordSchema = Schema.Union([
  OperationStartedRecord,
  AbortRequestedRecord,
  OperationFinishedRecord,
  StepAttemptRecord,
  ToolStartedRecord,
  QueueEnqueuedRecord,
  QueueCancelledRecord,
  WriteDeferredRecord,
  UsageRecord,
]);

// ── Decoders ────────────────────────────────────────────────────────

const decodeEntry = Schema.decodeUnknownSync(EntrySchema);
const decodeRecord = Schema.decodeUnknownSync(LaneRecordSchema);

// ── Builders ────────────────────────────────────────────────────────

/** Complete a provisioned entry by adding storage-assigned fields.
 *
 *  Validates the final shape against `EntrySchema`, then returns it typed
 *  as the caller's `TEntry`. The schema types and pi's entry types are
 *  structurally equivalent but nominally distinct, so the one bridge cast
 *  sits here — callers never cast the result. */
export const buildEntry = <TEntry extends Entry>(
  provisioned: ProvisionedEntry<TEntry>,
  parentId: string | null,
  seq: number,
  timestamp: number,
): TEntry =>
  // SAFETY: adding parentId/seq/timestamp to a `ProvisionedEntry<TEntry>`
  // produces `TEntry` by construction; the decode validates that shape.
  decodeEntry({ ...provisioned, parentId, seq, timestamp }) as TEntry;

/** Complete a new record by adding storage-assigned fields.
 *
 *  Validates the structural shape against `LaneRecordSchema`, then returns
 *  it typed as the caller's `TRecord` (the same bridge as `buildEntry`). */
export const buildRecord = <TRecord extends LaneRecord>(
  provisioned: NewRecord<TRecord>,
  seq: number,
  timestamp: number,
): TRecord =>
  // SAFETY: adding seq/timestamp to a `NewRecord<TRecord>` produces
  // `TRecord` by construction; the decode validates that shape.
  decodeRecord({ ...provisioned, seq, timestamp }) as TRecord;
