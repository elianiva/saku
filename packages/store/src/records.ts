/**
 * JSON records (records.ts): the typed record layer over the `KvStore`
 * seam — a `RecordCollection<A>` is a JSON-document collection scoped to
 * one key prefix, so consumers never touch bytes, JSON, or prefixes.
 *
 * A collection is `jsonRecords(kv, prefix)`. Keys are relative to the
 * prefix: `get("log/0001")` reads `prefix + "log/0001"`, and `list()`
 * answers with keys relative to the prefix, so a consumer holding a
 * collection never sees (or builds) a full key. The prefix is prepended
 * verbatim — the collection adds no separator — so a path-style prefix
 * should end with "/" (`"threads/"`, `"session/<id>/"`).
 *
 * Records are encoded as `JSON.stringify(record) + "\n"` (the hub's
 * registry and skills encoding), so this layer is interchangeable with
 * any JSON-lines store. Writes are individually atomic because the
 * backend's writes are (see kv.ts): a crash leaves a prefix of the log,
 * never a torn record.
 *
 * Failure posture matches the seam: storage defects kill the caller
 * (error channel `never`); data defects read as absence.
 *
 * - `get` on a missing OR corrupt record answers `Option.none` — "no
 *   record", never a `JSON.parse` defect (do-session maps that none to
 *   its not-found `SessionError`)
 * - `list` skips corrupt entries with a `logWarning` (the key stays on
 *   disk for inspection), so a boot-time load survives one bad record
 *   without losing the rest — the hub's current load policy, lifted onto
 *   the seam
 *
 * `list()` order is the backend's order: DO storage sorts
 * lexicographically, the memory and file backends do not — callers that
 * need an order must sort by key (do-session sorts by sequence).
 */

import { Effect, Option } from "effect";

import type { KvStoreApi } from "./kv.ts";

/** A typed JSON record collection scoped to one key prefix of a KvStore. */
export interface RecordCollection<A> {
  readonly get: (key: string) => Effect.Effect<Option.Option<A>>;
  readonly put: (key: string, record: A) => Effect.Effect<void>;
  readonly delete: (key: string) => Effect.Effect<void>;
  readonly list: () => Effect.Effect<readonly { key: string; value: A }[]>;
}

/**
 * A typed JSON record collection over one key prefix of `kv`. The
 * collection keeps the shape of the seam (same error channel, same
 * atomicity), so it is interchangeable with a raw `KvStoreApi`.
 */
export const jsonRecords = <A>(kv: KvStoreApi, prefix: string): RecordCollection<A> => {
  /**
   * Whether the parsed value has the object shape every record has.
   * Generic in `B` so the caller's `unknown` parse result narrows to `A & B`
   * (i.e. `A`) without an assertion: the object check is the whole shape
   * contract the stored bytes cross.
   */
  const isRecordObject = <B>(value: B): value is A & B => {
    // The boolean result of the object check; the `A` in the annotation is
    // the record type this guard hands back to decodeRecord.
    const isObject: A | boolean = typeof value === "object" && value !== null;
    return isObject;
  };

  const decodeRecord = (value: Uint8Array): A => {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(value));
    // Records are written by `put` from values of type A, and every caller
    // instantiates A with a JSON-object type — so the object check above is
    // the whole boundary the bytes cross; the `Effect.try` at the call sites
    // below turns any parse failure or shape mismatch into absence.
    if (!isRecordObject(parsed)) {
      throw new Error("[store] corrupt record: expected a JSON object");
    }
    return parsed;
  };

  return {
    delete: (key) => kv.delete(`${prefix}${key}`),
    get: (key) =>
      kv.get(`${prefix}${key}`).pipe(
        Effect.flatMap((value) =>
          Option.match(value, {
            // Missing and corrupt both read as "no record".
            onNone: () => Effect.succeed(Option.none<A>()),
            onSome: (bytes) =>
              Effect.try(() => Option.some(decodeRecord(bytes))).pipe(
                Effect.catchEager(() => Effect.succeed(Option.none<A>())),
              ),
          }),
        ),
      ),
    list: () =>
      kv.list({ prefix }).pipe(
        Effect.flatMap((entries) =>
          Effect.forEach(
            entries,
            (entry) =>
              Effect.try(() => ({
                key: entry.key.slice(prefix.length),
                value: decodeRecord(entry.value),
              })).pipe(
                Effect.catchEager((failure) =>
                  // Corrupt record: skip (the key stays on disk for inspection).
                  Effect.logWarning(
                    `[store] skipping corrupt record at ${entry.key}: ${String(failure)}`,
                  ).pipe(Effect.as(undefined satisfies undefined)),
                ),
              ),
            { concurrency: 1 },
          ),
        ),
        Effect.map((records) => records.filter((record) => record !== undefined)),
      ),
    put: (key, record) =>
      kv.put(`${prefix}${key}`, new TextEncoder().encode(`${JSON.stringify(record)}\n`)),
  };
};
