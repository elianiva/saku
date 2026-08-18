/**
 * The registry's disk round-trip (registry.test.ts): create → persist →
 * reload, over the real Node filesystem in a temp home (`PathsTest` — no
 * env mutation, cleaned up when the run's scope closes). This is the
 * regression for the persisted-record decoder: records are written as JSON
 * strings and must decode back on the next daemon boot (a schema that only
 * accepts objects made every persisted thread invisible after a restart).
 */

import { tmpdir } from "node:os";
import path from "node:path";

import { NodeFileSystem } from "@effect/platform-node";
import { Effect, FileSystem, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { Paths, PathsTest } from "../src/paths.ts";
import type { ThreadRecord } from "../src/registry-record.ts";
import { ThreadRecordSchema, DECODE_THREAD_RECORD } from "../src/registry-record.ts";
import { ThreadRegistry, ThreadRegistryTest } from "../src/registry.ts";
import { expectPresent } from "./expect.ts";

const recordOf = (id: string): ThreadRecord => ({
  archivedAt: null,
  createdAt: 1234,
  cwd: "/tmp",
  id,
  mode: "local",
  name: "round trip",
  nameAuto: true,
  sessionId: null,
});

const makeTempDir = (prefix: string) =>
  Effect.provide(NodeFileSystem.layer)(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.makeTempDirectory({ directory: tmpdir(), prefix });
    }),
  );

const removeDir = (dir: string) =>
  Effect.provide(NodeFileSystem.layer)(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(dir, { force: true, recursive: true });
    }).pipe(Effect.catch(() => Effect.void)),
  );

/** Write a record file exactly as the registry persists it (`threads/<id>/thread.json`). */
const writeRecordFile = Effect.fn("writeRecordFile")(function* (record: ThreadRecord) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Paths;
  const dir = path.join(paths.threadsDir, record.id);
  yield* fs.makeDirectory(dir, { recursive: true });
  yield* fs.writeFileString(path.join(dir, "thread.json"), `${JSON.stringify(record, null, 2)}\n`);
});

/**
 * Run one boot against the test registry. With no `home`, each run gets a
 * fresh scoped temp home; pass `home` to reuse one layout across boots.
 * `PathsTest` is provided here too (not just hidden inside
 * `ThreadRegistryTest`): the disk tests' bodies read `Paths` directly, and
 * the same `home` pins both instances to one layout.
 */
const runRegistry = async <A, E>(
  body: Effect.Effect<A, E, ThreadRegistry | FileSystem.FileSystem | Paths>,
  home?: string,
) =>
  await Effect.runPromise(
    Effect.provide(NodeFileSystem.layer)(
      Effect.provide(PathsTest(home))(Effect.provide(ThreadRegistryTest(home))(body)),
    ),
  );

describe("registry disk round-trip", () => {
  it("decodes a persisted record from disk on boot", async () => {
    const home = await Effect.runPromise(makeTempDir("saku-registry-decode-"));
    try {
      const record = recordOf("a".repeat(32));
      // Boot 1 writes the record. The registry layer builds at its provide
      // site, so a write in the same boot would land after the boot load
      // (the in-memory index is loaded once, at layer build).
      await runRegistry(
        Effect.gen(function* () {
          yield* writeRecordFile(record);
        }),
        home,
      );
      // Boot 2 (a restarted daemon) decodes the record from disk.
      const threads = await runRegistry(
        Effect.gen(function* () {
          return yield* ThreadRegistry.pipe(Effect.flatMap((registry) => registry.list()));
        }),
        home,
      );
      expect(threads).toEqual([{ ...record, nameAuto: true }]);
    } finally {
      await Effect.runPromise(removeDir(home));
    }
  });

  it("round-trips create → reload → list through the real filesystem", async () => {
    // A reload is a second boot over the same layout, so the home is pinned
    // (a fresh scoped home would be recreated per boot — exactly what a
    // restart must NOT see).
    const home = await Effect.runPromise(makeTempDir("saku-registry-reload-"));
    try {
      const created = await runRegistry(
        Effect.gen(function* () {
          const registry = yield* ThreadRegistry;
          return yield* registry.create({ cwd: "/tmp", mode: "local", name: "round trip" });
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
      expect(expectPresent(threads[0], "the reloaded thread").name).toBe("round trip");
    } finally {
      await Effect.runPromise(removeDir(home));
    }
  });

  it("skips corrupt records without failing the boot", async () => {
    const home = await Effect.runPromise(makeTempDir("saku-registry-corrupt-"));
    try {
      const good = recordOf("c".repeat(32));
      const corruptId = "d".repeat(32);
      // Boot 1 seeds the layout: one good record, one corrupt file.
      await runRegistry(
        Effect.gen(function* () {
          yield* writeRecordFile(good);
          const fs = yield* FileSystem.FileSystem;
          const paths = yield* Paths;
          yield* fs.makeDirectory(path.join(paths.threadsDir, corruptId), { recursive: true });
          yield* fs.writeFileString(
            path.join(paths.threadsDir, corruptId, "thread.json"),
            "not json at all",
          );
        }),
        home,
      );
      // Boot 2 loads the good record and skips the corrupt file.
      const threads = await runRegistry(
        Effect.gen(function* () {
          return yield* ThreadRegistry.pipe(Effect.flatMap((registry) => registry.list()));
        }),
        home,
      );
      expect(threads).toEqual([{ ...good, nameAuto: true }]);
    } finally {
      await Effect.runPromise(removeDir(home));
    }
  });

  it("the record schema decodes exactly what the registry writes", () => {
    const record = recordOf("e".repeat(32));
    const content = `${JSON.stringify(record, null, 2)}\n`;
    const decoded = DECODE_THREAD_RECORD(content);
    expect(decoded).toEqual(record);
    expect(Schema.decodeUnknownSync(ThreadRecordSchema)(JSON.parse(content))).toEqual(record);
  });

  it("decodes records written before archive as active (missing archivedAt)", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "saku-registry-legacy-"));
    try {
      const { archivedAt: _archivedAt, ...legacy } = recordOf("9".repeat(32));
      // Boot 1 seeds the layout with a pre-archive record.
      await runRegistry(
        Effect.gen(function* () {
          yield* writeRecordFile(legacy);
        }),
        home,
      );
      // Boot 2 (a restarted daemon) reads it back as active (archivedAt null).
      const threads = await runRegistry(
        Effect.gen(function* () {
          return yield* ThreadRegistry.pipe(Effect.flatMap((registry) => registry.list()));
        }),
        home,
      );
      expect(expectPresent(threads[0], "the legacy thread").archivedAt).toBeNull();
      expect(expectPresent(threads[0], "the legacy thread").name).toBe("round trip");
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });

  it("archives and unarchives, and the archive survives a reload", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "saku-registry-archive-"));
    try {
      const created = await runRegistry(
        Effect.gen(function* () {
          const registry = yield* ThreadRegistry;
          return yield* registry.create({ cwd: "/tmp", mode: "local", name: "round trip" });
        }),
        home,
      );
      const { id } = created;
      const archived = await runRegistry(
        Effect.gen(function* () {
          const registry = yield* ThreadRegistry;
          // The archive answers Option<ThreadRecord>.
          const result = yield* registry.archive(id);
          return result;
        }),
        home,
      );
      if (!Option.isSome(archived)) {
        throw new Error("expected the archive to answer Some");
      }
      expect(archived.value.archivedAt).not.toBeNull();

      // A fresh boot (a restarted daemon) keeps the archive flag.
      const reloaded = await runRegistry(
        Effect.gen(function* () {
          return yield* ThreadRegistry.pipe(Effect.flatMap((registry) => registry.list()));
        }),
        home,
      );
      expect(expectPresent(reloaded[0], "the archived thread").archivedAt).not.toBeNull();

      const unarchived = await runRegistry(
        Effect.gen(function* () {
          const registry = yield* ThreadRegistry;
          return yield* registry.unarchive(id);
        }),
        home,
      );
      if (!Option.isSome(unarchived)) {
        throw new Error("expected the unarchive to answer Some");
      }
      expect(unarchived.value.archivedAt).toBeNull();

      // Archiving an unknown thread answers None.
      const missing = await runRegistry(
        Effect.gen(function* () {
          const registry = yield* ThreadRegistry;
          return yield* registry.archive("8".repeat(32));
        }),
        home,
      );
      expect(missing._tag).toBe("None");
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });
});
