/**
 * KvStore tests: the storage service (memory + file backend layers).
 */

import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, FileSystem, Layer, Option } from "effect";

import { KvStore } from "../src/index.ts";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (value: Uint8Array): string => new TextDecoder().decode(value);

/** Run an effect that needs a KvStore against a backend layer. */
const run = <A>(
  layer: Layer.Layer<KvStore>,
  effect: Effect.Effect<A, never, KvStore>,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(layer)));

describe("KvStore.memory()", () => {
  it("round-trips put/get/list/delete", async () => {
    await run(
      KvStore.memory(),
      Effect.gen(function* () {
        const kv = yield* KvStore;
        expect(Option.isNone(yield* kv.get("meta"))).toBe(true);
        yield* kv.put("meta", encode("hello"));
        expect(decode(Option.getOrThrow(yield* kv.get("meta")))).toBe("hello");
        expect(yield* kv.list({ prefix: "log/" })).toHaveLength(0);
        yield* kv.put("log/0001", encode("one"));
        yield* kv.put("log/0002", encode("two"));
        const listed = yield* kv.list({ prefix: "log/" });
        expect(listed.map((e) => e.key).sort()).toEqual(["log/0001", "log/0002"]);
        yield* kv.delete("log/0001");
        expect((yield* kv.list({ prefix: "log/" })).map((e) => e.key)).toEqual(["log/0002"]);
        expect(Option.isNone(yield* kv.get("log/0001"))).toBe(true);
      }),
    );
  });

  it("isolates builds: each provided layer is a fresh store", async () => {
    const put = Effect.gen(function* () {
      const kv = yield* KvStore;
      yield* kv.put("meta", encode("a"));
    });
    const get = Effect.gen(function* () {
      const kv = yield* KvStore;
      expect(Option.isNone(yield* kv.get("meta"))).toBe(true);
    });
    await run(KvStore.memory(), put);
    await run(KvStore.memory(), get);
  });
});

describe("KvStore.file()", () => {
  it("round-trips through the filesystem (survives a restart)", async () => {
    const fs = await Effect.runPromise(
      Effect.provide(NodeFileSystem.layer)(
        Effect.gen(function* () {
          return yield* FileSystem.FileSystem;
        }),
      ),
    );
    const root = await fs.makeTempDirectory({ prefix: "saku-kv-" }).pipe(Effect.runPromise);
    const runFile = <A>(effect: Effect.Effect<A, never, KvStore>): Promise<A> =>
      run(KvStore.file(fs, root), effect);
    await runFile(
      Effect.gen(function* () {
        const kv = yield* KvStore;
        yield* kv.put("meta", encode("persisted"));
        yield* kv.put("log/0001", encode('{"kind":"lane"}'));
      }),
    );
    // A fresh store over the same root sees the writes.
    await runFile(
      Effect.gen(function* () {
        const kv = yield* KvStore;
        expect(decode(Option.getOrThrow(yield* kv.get("meta")))).toBe("persisted");
        expect((yield* kv.list({ prefix: "log/" })).map((e) => e.key)).toEqual(["log/0001"]);
        yield* kv.delete("log/0001");
        expect(yield* kv.list({ prefix: "log/" })).toHaveLength(0);
      }),
    );
    // Best-effort cleanup.
    await fs.remove(root, { recursive: true, force: true }).pipe(Effect.runPromise);
  });
});
