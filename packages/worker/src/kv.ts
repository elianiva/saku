/**
 * Key-value storage (kv.ts): the durability seam between the worker's
 * session trail and whatever host it runs on.
 *
 * The interface maps 1:1 onto Cloudflare Durable Object storage (`get`,
 * `put`, `delete`, `list`), so the same worker code runs inside a DO (M2/M4)
 * and inside the local daemon. Implementations:
 *
 * - `memoryKv` — in-memory (tests, in-process daemons)
 * - `fileKv`   — one file per key under a root directory, atomic tmp+rename
 *   writes, so the local daemon's trail survives restarts and a crash never
 *   leaves a torn key
 *
 * Values are opaque byte strings; keys are forward-slash paths ("log/0001").
 * Writes are individually atomic (a crash leaves a prefix of the log, which
 * is exactly what the session storage's replay expects).
 */

import { Effect, FileSystem } from "effect";

import { isNotFound } from "./fs.ts";

export interface KvEntry {
  readonly key: string;
  readonly value: Uint8Array;
}

/** The storage seam. DO storage adapters implement this (CF: trivially). */
export interface KvStore {
  readonly get: (key: string) => Promise<Uint8Array | undefined>;
  readonly put: (key: string, value: Uint8Array) => Promise<void>;
  readonly delete: (key: string) => Promise<void>;
  readonly list: (options: { prefix: string }) => Promise<readonly KvEntry[]>;
}

const encode = (value: string | Uint8Array): Uint8Array =>
  typeof value === "string" ? new TextEncoder().encode(value) : value;

const decode = (value: Uint8Array): string => new TextDecoder().decode(value);

/** In-memory KvStore. Each instance is a fresh store. */
export const memoryKv = (): KvStore => {
  const map = new Map<string, Uint8Array>();
  return {
    get: async (key) => map.get(key),
    put: async (key, value) => {
      map.set(key, new Uint8Array(value));
    },
    delete: async (key) => {
      map.delete(key);
    },
    list: async ({ prefix }) =>
      [...map.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value: new Uint8Array(value) })),
  };
};

/** Keys are stored verbatim under the root; nested keys get directories. */
const keyPath = (root: string, key: string): string => `${root}/${key}`;

/**
 * Walk a directory tree and return every file as a `{ key, path }` pair,
 * with keys relative to `root`. Effect-based; the promise boundary is the
 * caller's (the KvStore contract is promise-based).
 */
const listFiles = (
  fs: FileSystem.FileSystem,
  root: string,
  dir: string,
  prefix: string,
): Effect.Effect<readonly { key: string; path: string }[], never> =>
  Effect.gen(function* () {
    const names = yield* fs.readDirectory(dir).pipe(Effect.catchEager(() => Effect.succeed([] as string[])));
    const entries: { key: string; path: string }[] = [];
    for (const name of names) {
      const path = `${dir}/${name}`;
      const key = `${prefix}${name}`;
      const stat = yield* fs.stat(path).pipe(Effect.catchEager(() => Effect.succeed(undefined)));
      if (stat === undefined) continue;
      if (stat.type === "Directory") {
        entries.push(...(yield* listFiles(fs, root, path, `${key}/`)));
      } else {
        entries.push({ key, path });
      }
    }
    return entries;
  });

/**
 * File-backed KvStore over the `FileSystem` service. Writes go to
 * `key + ".tmp"` and rename over the destination, so a crash mid-write
 * leaves either the old or the new value, never a partial one.
 */
export const fileKv = (fs: FileSystem.FileSystem, root: string): KvStore => ({
  get: (key) =>
    Effect.runPromise(
      fs.readFileString(keyPath(root, key)).pipe(
        Effect.map((text) => encode(text)),
        Effect.catchEager((error) => (isNotFound(error) ? Effect.succeed(undefined) : Effect.fail(error))),
      ),
    ),
  put: (key, value) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const path = keyPath(root, key);
        const tmp = `${path}.tmp`;
        yield* fs.makeDirectory(dirname(path), { recursive: true });
        yield* fs.writeFile(tmp, value);
        yield* fs.rename(tmp, path);
      }),
    ),
  delete: (key) =>
    Effect.runPromise(
      fs.remove(keyPath(root, key), { force: true }).pipe(Effect.catchEager(() => Effect.void)),
    ),
  list: ({ prefix }) =>
    Effect.runPromise(
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
    ),
});

const dirname = (path: string): string => path.slice(0, path.lastIndexOf("/")) || path;
