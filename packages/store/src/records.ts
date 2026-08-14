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

import type { KvStoreShape } from "./kv.ts";

/** A typed JSON record collection scoped to one key prefix of a KvStore. */
export interface RecordCollection<A> {
  readonly get: (key: string) => Effect.Effect<Option.Option<A>, never>;
  readonly put: (key: string, record: A) => Effect.Effect<void, never>;
  readonly delete: (key: string) => Effect.Effect<void, never>;
  readonly list: () => Effect.Effect<readonly { key: string; value: A }[], never>;
}

/** The record encoding: `JSON.stringify(record) + "\n"` (the hub's encoding). */
const encodeRecord = <A>(record: A) => new TextEncoder().encode(`${JSON.stringify(record)}\n`);

const decodeRecord = <A>(value: Uint8Array) => JSON.parse(new TextDecoder().decode(value)) as A;

/**
 * A typed JSON record collection over one key prefix of `kv`. The
 * collection keeps the shape of the seam (same error channel, same
 * atomicity), so it is interchangeable with a raw `KvStoreShape`.
 */
export const jsonRecords = <A>(kv: KvStoreShape, prefix: string): RecordCollection<A> => ({
  get: (key) =>
    kv.get(`${prefix}${key}`).pipe(
      Effect.flatMap((value) =>
        Option.match(value, {
          // Missing and corrupt both read as "no record".
          onNone: () => Effect.succeed(Option.none<A>()),
          onSome: (bytes) =>
            Effect.try(() => Option.some(decodeRecord<A>(bytes))).pipe(
              Effect.catch(() => Effect.succeed(Option.none<A>())),
            ),
        }),
      ),
    ),
  put: (key, record) => kv.put(`${prefix}${key}`, encodeRecord(record)),
  delete: (key) => kv.delete(`${prefix}${key}`),
  list: () =>
    kv.list({ prefix }).pipe(
      Effect.flatMap((entries) =>
        Effect.forEach(entries, (entry) =>
          Effect.try(() => ({
            key: entry.key.slice(prefix.length),
            value: decodeRecord<A>(entry.value),
          })).pipe(
            Effect.catch((error) =>
              // Corrupt record: skip (the key stays on disk for inspection).
              Effect.logWarning(
                `[store] skipping corrupt record at ${entry.key}: ${String(error)}`,
              ).pipe(Effect.as(undefined)),
            ),
          ),
        ),
      ),
      Effect.map((records) => records.filter((record) => record !== undefined)),
    ),
});
