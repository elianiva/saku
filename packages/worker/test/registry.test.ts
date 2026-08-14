/**
 * The registry's disk round-trip (registry.test.ts): create → persist →
 * reload, over the real Node filesystem in a temp home (`PathsTest` — no
 * env mutation, cleaned up when the run's scope closes). This is the
 * regression for the persisted-record decoder: records are written as JSON
 * strings and must decode back on the next daemon boot (a schema that only
 * accepts objects made every persisted thread invisible after a restart).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeFileSystem } from "@effect/platform-node";
import { Effect, FileSystem, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { Paths } from "../src/paths.ts";
import { ThreadRecord, ThreadRecordSchema, DECODE_THREAD_RECORD } from "../src/registry-record.ts";
import { ThreadRegistry, ThreadRegistryTest } from "../src/registry.ts";

const recordOf = (id: string): ThreadRecord => ({
  id,
  name: "round trip",
  cwd: "/tmp",
  mode: "local",
  createdAt: 1234,
  sessionId: null,
  nameAuto: true,
});

/** Write a record file exactly as the registry persists it. */
const writeRecordFile = Effect.fn("writeRecordFile")(function* (record: ThreadRecord) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Paths;
  yield* fs.makeDirectory(paths.threadDir(record.id), { recursive: true });
  yield* fs.writeFileString(paths.threadFile(record.id), `${JSON.stringify(record, null, 2)}\n`);
});

/**
 * Run one boot against the test registry. With no `home`, each run gets a
 * fresh scoped temp home; pass `home` to reuse one layout across boots.
 */
const runRegistry = <A, E, R>(
  body: Effect.Effect<A, E, R>,
  home?: string,
): Promise<A> =>
  Effect.runPromise(
    Effect.provide(NodeFileSystem.layer)(
      Effect.provide(ThreadRegistryTest(home))(body),
    ),
  );

describe("registry disk round-trip", () => {
  it("decodes a persisted record from disk on boot", async () => {
    const [record, threads] = await runRegistry(
      Effect.gen(function* () {
        const record = recordOf("a".repeat(32));
        yield* writeRecordFile(record);
        const threads = yield* ThreadRegistry.pipe(Effect.flatMap((registry) => registry.list()));
        return [record, threads] as const;
      }),
    );
    expect(threads).toEqual([{ ...record, nameAuto: true }]);
  });

  it("round-trips create → reload → list through the real filesystem", async () => {
    // A reload is a second boot over the same layout, so the home is pinned
    // (a fresh scoped home would be recreated per boot — exactly what a
    // restart must NOT see).
    const home = await mkdtemp(join(tmpdir(), "saku-registry-reload-"));
    try {
      const created = await runRegistry(
        Effect.gen(function* () {
          const registry = yield* ThreadRegistry;
          return yield* registry.create(recordOf("b".repeat(32)));
        }),
        home,
      );
      expect(created.name).toBe("round trip");

      // A fresh boot (a restarted daemon) reloads from disk.
      const threads = await runRegistry(
        Effect.gen(function* () {
          return yield* ThreadRegistry.pipe(Effect.flatMap((registry) => registry.list()));
        }),
        home,
      );
      expect(threads).toHaveLength(1);
      expect(threads[0]!.name).toBe("round trip");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("skips corrupt records without failing the boot", async () => {
    const [good, threads] = await runRegistry(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* Paths;
        const good = recordOf("c".repeat(32));
        yield* writeRecordFile(good);
        const corruptId = "d".repeat(32);
        yield* fs.makeDirectory(paths.threadDir(corruptId), { recursive: true });
        yield* fs.writeFileString(paths.threadFile(corruptId), "not json at all");
        const threads = yield* ThreadRegistry.pipe(Effect.flatMap((registry) => registry.list()));
        return [good, threads] as const;
      }),
    );
    expect(threads).toEqual([{ ...good, nameAuto: true }]);
  });

  it("the record schema decodes exactly what the registry writes", () => {
    const record = recordOf("e".repeat(32));
    const content = `${JSON.stringify(record, null, 2)}\n`;
    const decoded = DECODE_THREAD_RECORD(content);
    expect(decoded).toEqual(record);
    expect(Schema.decodeUnknownSync(ThreadRecordSchema)(JSON.parse(content))).toEqual(record);
  });
});
