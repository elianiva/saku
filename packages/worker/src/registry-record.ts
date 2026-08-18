/**
 * The registry record contract (registry-record.ts): the durable thread
 * record — id, name, cwd, mode, session id, auto-title flag — schema,
 * type, and decoder, in their own module so the isolate entry (the
 * thread DO) can decode `/create` payloads against it without pulling
 * the node-bound file registry (`registry.ts` → `paths.ts`).
 */

import { Schema } from "effect";
import { ThreadMode, ThreadSource } from "@saku/wire";

export const ThreadRecordSchema = Schema.Struct({
  /** Archive visibility lifecycle (CONTEXT.md: Archive); null when active. The
   * optional key keeps records written before archive readable (normalized
   * to null at load — the schema never sees the missing key). */
  archivedAt: Schema.optionalKey(Schema.Union([Schema.Null, Schema.Number])),
  createdAt: Schema.Number,
  cwd: Schema.String,
  id: Schema.String,
  /** Hands policy, pinned at creation. */
  mode: ThreadMode,
  name: Schema.String,
  /** The name is an auto-generated prompt snippet awaiting auto-title (CONTEXT.md: Quick start, Auto-title). */
  nameAuto: Schema.Boolean,
  /** Pi session id, stable across daemon restarts; set on first touch. */
  sessionId: Schema.Union([Schema.Null, Schema.String]),
  /** Adoption provenance; absent on threads created from scratch. */
  source: Schema.optional(ThreadSource),
});

/**
 * A thread's registry record: id, name, cwd, mode, session id, auto-title
 * flag — what the daemon persists to `threads/<id>/thread.json`.
 */
export type ThreadRecord = Schema.Schema.Type<typeof ThreadRecordSchema>;

/** Decode a persisted record (a JSON string as written by the registry). */
export const DECODE_THREAD_RECORD = Schema.decodeUnknownSync(
  Schema.fromJsonString(ThreadRecordSchema),
);
