/**
 * The registry's disk round-trip (registry.test.ts): create → persist →
 * reload, over the real Node filesystem in a temp SAKU_HOME. This is the
 * regression for the persisted-record decoder: records are written as JSON
 * strings and must decode back on the next daemon boot (a schema that only
 * accepts objects made every persisted thread invisible after a restart).
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Layer, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getThreadFile } from "../src/paths.ts";
import { ThreadRecord, ThreadRecordSchema, DECODE_THREAD_RECORD } from "../src/registry-record.ts";
import { ThreadRegistry, ThreadRegistryLive } from "../src/registry.ts";

let sakuHome: string;

beforeEach(async () => {
  sakuHome = await mkdtemp(join(tmpdir(), "saku-registry-test-"));
  process.env.SAKU_HOME = sakuHome;
});

afterEach(async () => {
  delete process.env.SAKU_HOME;
  await rm(sakuHome, { recursive: true, force: true });
});

/** Build the live registry against the temp home. */
const buildRegistry = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* ThreadRegistry;
    }).pipe(Effect.provide(ThreadRegistryLive), Effect.provide(NodeFileSystem.layer)),
  );

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
const writeRecordFile = async (record: ThreadRecord): Promise<void> => {
  await mkdir(join(sakuHome, "threads", record.id), { recursive: true });
  await writeFile(getThreadFile(record.id), `${JSON.stringify(record, null, 2)}\n`, "utf8");
};

describe("registry disk round-trip", () => {
  it("decodes a persisted record from disk on boot", async () => {
    const record = recordOf("a".repeat(32));
    await writeRecordFile(record);

    const registry = await buildRegistry();
    const threads = await Effect.runPromise(registry.list());
    expect(threads).toEqual([{ ...record, nameAuto: true }]);
  });

  it("round-trips create → reload → list through the real filesystem", async () => {
    const registry = await buildRegistry();
    await Effect.runPromise(registry.create(recordOf("b".repeat(32))));

    // A fresh boot (a restarted daemon) reloads from disk.
    const reloaded = await buildRegistry();
    const threads = await Effect.runPromise(reloaded.list());
    expect(threads).toHaveLength(1);
    expect(threads[0]!.name).toBe("round trip");
  });

  it("skips corrupt records without failing the boot", async () => {
    const good = recordOf("c".repeat(32));
    await writeRecordFile(good);
    await mkdir(join(sakuHome, "threads", "d".repeat(32)), { recursive: true });
    await writeFile(getThreadFile("d".repeat(32)), "not json at all", "utf8");

    const registry = await buildRegistry();
    const threads = await Effect.runPromise(registry.list());
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
