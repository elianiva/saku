/**
 * DO storage as the `KvStore` seam (kv.ts): the Durable Object storage
 * contract `@saku/store` defines maps 1:1 onto `state.storage` — the
 * hub's registry and skills store and the worker's session trail run on
 * it unchanged inside a DO (Cloudflare or celld).
 */

import type { KvEntry, KvStore } from "@saku/store";

/** The `DurableObjectStorage` surface we need (from cloudflare:workers). */
export interface DoStorageLike {
  readonly get: (key: string) => Promise<unknown>;
  readonly put: (key: string, value: unknown) => Promise<void>;
  readonly delete: (key: string) => Promise<boolean>;
  readonly deleteAll: () => Promise<void>;
  readonly list: (options?: { prefix?: string }) => Promise<Map<string, unknown>>;
}

export const doStorageKv = (storage: DoStorageLike): KvStore => ({
  get: async (key) => {
    const value = await storage.get(key);
    return value instanceof Uint8Array ? value : undefined;
  },
  put: async (key, value) => {
    await storage.put(key, value);
  },
  delete: async (key) => {
    await storage.delete(key);
  },
  list: async ({ prefix }) => {
    const entries = await storage.list({ prefix });
    const out: KvEntry[] = [];
    for (const [key, value] of entries) {
      if (value instanceof Uint8Array) out.push({ key, value });
    }
    return out;
  },
});
