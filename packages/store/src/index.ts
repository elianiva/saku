/**
 * saku/store — the durability seam: the `KvStore` Effect service (the
 * Durable Object storage contract) with its memory, file, and DO storage
 * backend layers, the typed JSON record collection (`jsonRecords`) that
 * scopes records to one key prefix per consumer, and the shared
 * platform-error helper. Used by the hub (registry, skills store) and the
 * worker (session trail).
 */

export { KvStore, type DoStorageLike, type KvEntry, type KvStoreApi } from "./kv.ts";
export { isNotFound } from "./platform-error.ts";
export { jsonRecords, type RecordCollection } from "./records.ts";
