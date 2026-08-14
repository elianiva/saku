/**
 * Key-value storage (kv.ts): the durability seam between saku's state —
 * the hub's registry and skills store, the worker's session trail — and
 * whatever host it runs on.
 *
 * The seam is an Effect service, shaped like elianiva.com's `KvCache`: a
 * `Context.Service` class whose backends are static layer factories.
 * Consumers `yield* KvStore` and never see a backend; each composition
 * site (the hub DO, the thread DO, the daemon, the tests) provides the
 * backend layer at the boundary. Backends are built lazily (`Layer.sync`)
 * and fresh per build, so two provides never share state.
 *
 * The shape maps 1:1 onto Cloudflare Durable Object storage (`get`,
 * `put`, `delete`, `list`), so the same code runs inside a DO (hub and
 * worker in production) and in-process (celld, tests, the local spine).
 * Backends — all static factories on the service:
 *
 * - `KvStore.memory()`        — in-memory (tests, in-process daemons)
 * - `KvStore.file(fs, root)`  — one file per key under a root directory,
 *   atomic tmp+rename writes, so local state survives restarts and a
 *   crash never leaves a torn key
 * - `KvStore.doStorage(...)`  — Durable Object storage (the platform
 *   boundary; Cloudflare and celld)
 *
 * Values are opaque byte strings; keys are forward-slash paths ("log/0001").
 * Writes are individually atomic (a crash leaves a prefix of the log, which
 * is exactly what the session storage's replay expects). Reads answer with
 * `Option`: a missing key is `Option.none`, never `undefined` — null/undefined
 * are banned on this seam.
 *
 * The seam is effect-based with error channel `never`: storage defects kill
 * the caller, which is what DO storage does. The promise boundary is the pi
 * seam (`do-session.ts`), not here — no promise crosses this file.
 */

import { Array, Context, Effect, FileSystem, Layer, Option } from "effect";

import { isNotFound } from "./fs.ts";

export interface KvEntry {
  readonly key: string;
  readonly value: Uint8Array;
}

/** The storage shape. DO storage adapters implement this (CF: trivially). */
export interface KvStoreShape {
  readonly get: (key: string) => Effect.Effect<Option.Option<Uint8Array>, never>;
  readonly put: (key: string, value: Uint8Array) => Effect.Effect<void, never>;
  readonly delete: (key: string) => Effect.Effect<void, never>;
  readonly list: (options: { prefix: string }) => Effect.Effect<readonly KvEntry[], never>;
}

/** The `DurableObjectStorage` surface we need (from cloudflare:workers). */
export interface DoStorageLike {
  readonly get: (key: string) => Promise<unknown>;
  readonly put: (key: string, value: unknown) => Promise<void>;
  readonly delete: (key: string) => Promise<boolean>;
  readonly deleteAll: () => Promise<void>;
  readonly list: (options?: { prefix?: string }) => Promise<Map<string, unknown>>;
}

/**
 * The storage service: `yield* KvStore` where a durable seam is needed,
 * and provide one of the backend layers at the boundary. Each backend's
 * implementation lives in its static factory (the `KvCache.layerFrom`
 * shape); only pure helpers sit below.
 */
export class KvStore extends Context.Service<KvStore, KvStoreShape>()("KvStore") {
  /**
   * In-memory backend (tests, in-process daemons). Each build is a fresh
   * store; two provides never share state.
   */
  static memory(): Layer.Layer<KvStore> {
    return Layer.sync(KvStore, () => {
      const map = new Map<string, Uint8Array>();
      return {
        get: (key) => Effect.succeed(Option.fromUndefinedOr(map.get(key))),
        put: (key, value) =>
          Effect.sync(() => {
            map.set(key, new Uint8Array(value));
          }),
        delete: (key) =>
          Effect.sync(() => {
            map.delete(key);
          }),
        list: ({ prefix }) =>
          Effect.succeed(
            [...map.entries()]
              .filter(([key]) => key.startsWith(prefix))
              .map(([key, value]) => ({ key, value: new Uint8Array(value) })),
          ),
      };
    });
  }

  /**
   * File backend: one file per key under `root`, over the given FileSystem.
   * Writes go to `key + ".tmp"` and rename over the destination, so a crash
   * mid-write leaves either the old or the new value, never a partial one.
   */
  static file(fs: FileSystem.FileSystem, root: string): Layer.Layer<KvStore> {
    return Layer.sync(KvStore, () => ({
      get: (key) =>
        fs.readFileString(keyPath(root, key)).pipe(
          Effect.map((text) => Option.some(encode(text))),
          // A missing key is `Option.none`; any other storage defect dies —
          // the seam's failure posture is "defects kill the caller".
          Effect.catchEager((error) =>
            isNotFound(error) ? Effect.succeed(Option.none()) : Effect.die(error),
          ),
        ),
      put: Effect.fn("put")(
        function* (key: string, value: Uint8Array) {
          const path = keyPath(root, key);
          const tmp = `${path}.tmp`;
          yield* fs.makeDirectory(dirname(path), { recursive: true });
          yield* fs.writeFile(tmp, value);
          yield* fs.rename(tmp, path);
        },
        (effect) => effect.pipe(Effect.orDie),
      ),
      delete: (key) =>
        fs.remove(keyPath(root, key), { force: true }).pipe(Effect.catchEager(() => Effect.void)),
      list: ({ prefix }) =>
        listFiles(fs, root, root, "").pipe(
          Effect.flatMap((files) =>
            Effect.forEach(
              files.filter((file) => file.key.startsWith(prefix)),
              (file) =>
                fs.readFileString(file.path).pipe(
                  Effect.map((text) => ({ key: file.key, value: encode(text) })),
                  Effect.catchEager(() => Effect.succeed({ key: file.key, value: encode("") })),
                ),
            ),
          ),
        ),
    }));
  }

  /**
   * Durable Object storage backend (the platform boundary; Cloudflare and
   * celld). The DO's promise API is the platform boundary: each call
   * crosses with `Effect.tryPromise` and `Effect.orDie` — the KvStore
   * channel is `never`, so a rejected DO promise is a defect that kills
   * the caller, which is exactly what DO storage does unadapted.
   */
  static doStorage(storage: DoStorageLike): Layer.Layer<KvStore> {
    return Layer.sync(KvStore, () => ({
      get: (key) =>
        Effect.tryPromise(async () => {
          const value = await storage.get(key);
          return value instanceof Uint8Array ? Option.some(value) : Option.none();
        }).pipe(Effect.orDie),
      put: (key, value) => Effect.tryPromise(() => storage.put(key, value)).pipe(Effect.orDie),
      delete: (key) =>
        Effect.tryPromise(async () => {
          await storage.delete(key);
        }).pipe(Effect.orDie),
      list: ({ prefix }) =>
        Effect.tryPromise(async () => {
          const entries = await storage.list({ prefix });
          const out: KvEntry[] = [];
          for (const [key, value] of entries) {
            if (value instanceof Uint8Array) out.push({ key, value });
          }
          return out;
        }).pipe(Effect.orDie),
    }));
  }
}

const encode = (value: string | Uint8Array): Uint8Array =>
  typeof value === "string" ? new TextEncoder().encode(value) : value;

/** Keys are stored verbatim under the root; nested keys get directories. */
const keyPath = (root: string, key: string): string => `${root}/${key}`;

/**
 * Walk a directory tree and return every file as a `{ key, path }` pair,
 * with keys relative to `root`. Directory entries are independent reads,
 * so they are traversed in parallel (`concurrency: "unbounded"`); results
 * stay in traversal order (the recursive shape is kept).
 */
const listFiles = (
  fs: FileSystem.FileSystem,
  root: string,
  dir: string,
  prefix: string,
): Effect.Effect<readonly { key: string; path: string }[], never> =>
  fs.readDirectory(dir).pipe(
    Effect.catchEager(() => Effect.succeed([] as string[])),
    Effect.flatMap((names) =>
      Effect.forEach(
        names,
        (name) => {
          const path = `${dir}/${name}`;
          const key = `${prefix}${name}`;
          return fs.stat(path).pipe(
            // A stat race (the file vanished between listing and stat) reads
            // as absent — the whole subtree contributes nothing.
            Effect.option,
            Effect.flatMap((stat) => {
              if (Option.isNone(stat)) return Effect.succeed([]);
              if (stat.value.type === "Directory") return listFiles(fs, root, path, `${key}/`);
              return Effect.succeed([{ key, path }]);
            }),
          );
        },
        { concurrency: "unbounded" },
      ),
    ),
    Effect.map(Array.flatten),
  );

const dirname = (path: string): string => path.slice(0, path.lastIndexOf("/")) || path;
