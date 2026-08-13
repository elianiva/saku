/**
 * The registry record contract (registry-record.ts): the durable thread
 * record — id, name, cwd, mode, session id, auto-title flag — schema,
 * type, and decoder, in their own module so the isolate entry (the
 * thread DO) can decode `/create` payloads against it without pulling
 * the node-bound file registry (`registry.ts` → `paths.ts`). The same
 * split as `registry-error.ts`.
 */

import { Schema } from "effect";
import { ThreadMode } from "@saku/wire";

export const ThreadRecordSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  cwd: Schema.String,
  /** Hands policy, pinned at creation. */
  mode: ThreadMode,
  createdAt: Schema.Number,
  /** Pi session id, stable across daemon restarts; set on first touch. */
  sessionId: Schema.Union([Schema.Null, Schema.String]),
  /** The name is an auto-generated prompt snippet awaiting auto-title (CONTEXT.md: Quick start, Auto-title). */
  nameAuto: Schema.Boolean,
});

/**
 * A thread's registry record: id, name, cwd, mode, session id, auto-title
 * flag — what the daemon persists to `threads/<id>/thread.json`.
 */
export type ThreadRecord = Schema.Schema.Type<typeof ThreadRecordSchema>;

export const DECODE_THREAD_RECORD = Schema.decodeUnknownSync(ThreadRecordSchema);
