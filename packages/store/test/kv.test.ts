/**
 * KvStore tests: the storage seam (memory + file backends).
 */

import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, FileSystem } from "effect";

import { fileKv, memoryKv } from "../src/index.ts";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (value: Uint8Array): string => new TextDecoder().decode(value);

describe("memoryKv", () => {
  it("round-trips put/get/list/delete", async () => {
    const kv = memoryKv();
    expect(await kv.get("meta")).toBeUndefined();
    await kv.put("meta", encode("hello"));
    expect(decode((await kv.get("meta"))!)).toBe("hello");
    expect((await kv.list({ prefix: "log/" })).length).toBe(0);
    await kv.put("log/0001", encode("one"));
    await kv.put("log/0002", encode("two"));
    const listed = await kv.list({ prefix: "log/" });
    expect(listed.map((e) => e.key).sort()).toEqual(["log/0001", "log/0002"]);
    await kv.delete("log/0001");
    expect((await kv.list({ prefix: "log/" })).map((e) => e.key)).toEqual(["log/0002"]);
    expect(await kv.get("log/0001")).toBeUndefined();
  });

  it("isolates instances", async () => {
    const a = memoryKv();
    const b = memoryKv();
    await a.put("meta", encode("a"));
    expect(await b.get("meta")).toBeUndefined();
  });
});

describe("fileKv", () => {
  it("round-trips through the filesystem (survives a restart)", async () => {
    const fs = await Effect.runPromise(
      Effect.provide(NodeFileSystem.layer)(
        Effect.gen(function* () {
          return yield* FileSystem.FileSystem;
        }),
      ),
    );
    const root = await Effect.runPromise(
      Effect.provide(NodeFileSystem.layer)(
        Effect.gen(function* () {
          const fsService = yield* FileSystem.FileSystem;
          return yield* fsService.makeTempDirectory({ prefix: "saku-kv-" });
        }),
      ),
    );
    const first = fileKv(fs, root);
    await first.put("meta", encode("persisted"));
    await first.put("log/0001", encode('{"kind":"lane"}'));
    // A fresh store over the same root sees the writes.
    const second = fileKv(fs, root);
    expect(decode((await second.get("meta"))!)).toBe("persisted");
    expect((await second.list({ prefix: "log/" })).map((e) => e.key)).toEqual(["log/0001"]);
    await second.delete("log/0001");
    expect((await first.list({ prefix: "log/" })).length).toBe(0);
    // Best-effort cleanup.
    await fs.remove(root, { recursive: true, force: true }).pipe(Effect.runPromise);
  });
});
