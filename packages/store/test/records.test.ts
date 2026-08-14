/**
 * RecordCollection tests: the typed JSON record layer over the storage
 * service (memory + file backend layers).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, FileSystem, Layer, Option } from "effect";

import { KvStore, jsonRecords } from "../src/index.ts";

interface TestRecord {
  readonly id: string;
  readonly n: number;
}

const encode = (text: string) => new TextEncoder().encode(text);

/** The collection assertions, run against whatever backend `run` provides. */
const cases = (run: <A>(effect: Effect.Effect<A, never, KvStore>) => Promise<A>) => {
  it("round-trips get/put/delete/list", async () => {
    await run(
      Effect.gen(function* () {
        const kv = yield* KvStore;
        const records = jsonRecords<TestRecord>(kv, "records/");
        expect(Option.isNone(yield* records.get("one"))).toBe(true);
        yield* records.put("one", { id: "one", n: 1 });
        expect(yield* records.get("one")).toEqual(Option.some({ id: "one", n: 1 }));
        yield* records.put("two", { id: "two", n: 2 });
        // list answers with keys relative to the prefix, in the backend's order.
        const listed = yield* records.list();
        expect(listed.map((entry) => entry.key).sort()).toEqual(["one", "two"]);
        expect(listed.map((entry) => entry.value)).toEqual(
          expect.arrayContaining([
            { id: "one", n: 1 },
            { id: "two", n: 2 },
          ]),
        );
        yield* records.delete("one");
        expect((yield* records.list()).map((entry) => entry.key)).toEqual(["two"]);
        expect(Option.isNone(yield* records.get("one"))).toBe(true);
      }),
    );
  });

  it("isolates prefixes on the same kv", async () => {
    await run(
      Effect.gen(function* () {
        const kv = yield* KvStore;
        const left = jsonRecords<TestRecord>(kv, "left/");
        const right = jsonRecords<TestRecord>(kv, "right/");
        yield* left.put("same", { id: "left", n: 1 });
        yield* right.put("same", { id: "right", n: 2 });
        expect((yield* left.list()).map((entry) => entry.key)).toEqual(["same"]);
        expect((yield* right.list()).map((entry) => entry.key)).toEqual(["same"]);
        expect(yield* left.get("same")).toEqual(Option.some({ id: "left", n: 1 }));
        expect(yield* right.get("same")).toEqual(Option.some({ id: "right", n: 2 }));
        yield* left.delete("same");
        expect(Option.isNone(yield* left.get("same"))).toBe(true);
        expect(Option.isSome(yield* right.get("same"))).toBe(true);
      }),
    );
  });

  it("skips corrupt records on list and reads them as none on get", async () => {
    await run(
      Effect.gen(function* () {
        const kv = yield* KvStore;
        const records = jsonRecords<TestRecord>(kv, "records/");
        yield* records.put("good", { id: "good", n: 1 });
        // A raw non-JSON value written under the prefix, behind the layer's back.
        yield* kv.put("records/corrupt", encode("not json"));
        expect(Option.isNone(yield* records.get("corrupt"))).toBe(true);
        const listed = yield* records.list();
        expect(listed).toEqual([{ key: "good", value: { id: "good", n: 1 } }]);
        // The good record is untouched.
        expect(yield* records.get("good")).toEqual(Option.some({ id: "good", n: 1 }));
      }),
    );
  });
};

describe("KvStore.memory()", () => {
  cases((effect) => Effect.runPromise(effect.pipe(Effect.provide(KvStore.memory()))));
});

describe("KvStore.file()", () => {
  let fs: FileSystem.FileSystem;
  beforeAll(async () => {
    fs = await Effect.runPromise(
      Effect.provide(NodeFileSystem.layer)(
        Effect.gen(function* () {
          return yield* FileSystem.FileSystem;
        }),
      ),
    );
  });
  cases(async (effect) => {
    // A fresh root per test: the file backend persists, so tests must not share state.
    const root = await fs.makeTempDirectory({ prefix: "saku-records-" }).pipe(Effect.runPromise);
    try {
      return await Effect.runPromise(effect.pipe(Effect.provide(KvStore.file(fs, root))));
    } finally {
      await fs.remove(root, { recursive: true, force: true }).pipe(Effect.runPromise);
    }
  });
});
