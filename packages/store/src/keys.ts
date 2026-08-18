/**
 * Storage key brands (keys.ts): nominal types for KvStore key patterns.
 *
 * Every key constructor returns a branded `string` — structurally identical
 * to a plain string but type-system-distinct, so a `SessionPrefix` cannot
 * accidentally flow into a slot that expects a `LogKey`. The brand is
 * compile-time only (no runtime wrapper); the constructor functions
 * validate and format in one step.
 */

import { Brand } from "effect";

// ---------------------------------------------------------------------------
// Session keys
// ---------------------------------------------------------------------------

/** A KvStore prefix that owns one session's keys (`session/<id>/`). */
export type SessionPrefix = string & Brand.Brand<"SessionPrefix">;

/** Build a session prefix from a validated session id. */
export const SessionPrefix = {
  create: (id: string) => `session/${id}/` as SessionPrefix,
};

/** A zero-padded log entry key (`log/<seq>`). */
export type LogKey = string & Brand.Brand<"LogKey">;

/** Build a log key, zero-padded so lexicographic order matches sequence order. */
export const LogKey = {
  create: (seq: number) => `log/${String(seq).padStart(12, "0")}` as LogKey,
};

// ---------------------------------------------------------------------------
// Registry record keys
// ---------------------------------------------------------------------------

/** A hub registry record key (`<id>/record`). */
export type HubRecordKey = string & Brand.Brand<"HubRecordKey">;

/** Build a hub registry record key. */
export const HubRecordKey = {
  create: (id: string) => `${id}/record` as HubRecordKey,
};

/** A worker registry record key (`<id>/thread.json`). */
export type WorkerRecordKey = string & Brand.Brand<"WorkerRecordKey">;

/** Build a worker registry record key. */
export const WorkerRecordKey = {
  create: (id: string) => `${id}/thread.json` as WorkerRecordKey,
};
