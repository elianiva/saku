/**
 * DoSessionRepo tests: pi's own backend conformance suite (both memory and
 * file KvStores) plus the durability properties the worker relies on:
 * a crash leaves a prefix of the log, and a restart replays it.
 */

import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "@effect/platform-node";
import type { Layer } from "effect";
import { Effect, FileSystem } from "effect";
import { createSessionBackendConformance } from "@earendil-works/pi-agent-core/session/testing";
import type { SessionBackendFixture } from "@earendil-works/pi-agent-core/session/testing";
import type { SessionRepo } from "@earendil-works/pi-agent-core";

import { DoSessionRepo } from "../src/do-session-repo.ts";
import type { DoSessionMetadata } from "../src/do-session.ts";
import type { KvEntry, KvStoreApi } from "@saku/store";
import { KvStore, LogKey, SessionPrefix } from "@saku/store";
import type { SessionMutation } from "../src/session-state.ts";

import { assistantMessage } from "./fakes.ts";
import { expectPresent } from "./expect.ts";

/** Build a KvStore value from a backend layer (the pi seam is value-shaped). */
const buildKv = async (layer: Layer.Layer<KvStore>) =>
  await Effect.runPromise(
    Effect.gen(function* () {
      const kv = yield* KvStore;
      return kv;
    }).pipe(Effect.provide(layer)),
  );

/** Run pi's conformance cases as vitest cases. */
const runConformance = (label: string, factory: () => Promise<SessionBackendFixture>) => {
  describe(`${label} conformance`, () => {
    for (const testCase of createSessionBackendConformance(factory)) {
      it(`${testCase.group}: ${testCase.name}`, async () => {
        await testCase.run();
      });
    }
  });
};

/** The one listed session: every durability case lists a just-created session. */
const expectSession = async (repo: SessionRepo<DoSessionMetadata>) => {
  const [metadata] = await repo.list();
  if (metadata === undefined) {
    throw new Error("expected the session to be listed");
  }
  return metadata;
};

const memoryFixture = async () => ({
  repository: new DoSessionRepo(await buildKv(KvStore.memory())),
  [Symbol.asyncDispose]: async () => {},
});

runConformance("memoryKv", memoryFixture);

// The file-backed fixture needs the FileSystem service; build its factory
// once inside a provided context (each case still gets a fresh temp dir).
const fileFixtureFactory = await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return async () => {
      const root = await Effect.runPromise(fs.makeTempDirectory({ prefix: "saku-trail-" }));
      const kv = await buildKv(KvStore.file(fs, root));
      return {
        repository: new DoSessionRepo(kv),
        [Symbol.asyncDispose]: async () => {
          await Effect.runPromise(
            fs.remove(root, { force: true, recursive: true }).pipe(Effect.catch(() => Effect.void)),
          );
        },
      };
    };
  }).pipe(Effect.provide(NodeFileSystem.layer)),
);

runConformance("fileKv", fileFixtureFactory);

/** Run a case against a fresh temp-dir file KvStore, torn down afterwards. */
const withFileKv = async <A>(run: (kv: KvStoreApi, fs: FileSystem.FileSystem) => Promise<A>) =>
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectory({ prefix: "saku-durability-" });
      const result = yield* Effect.gen(function* () {
        const kv = yield* KvStore;
        const outcome = yield* Effect.tryPromise(async () => await run(kv, fs)).pipe(
          Effect.ensuring(
            fs.remove(root, { force: true, recursive: true }).pipe(Effect.catch(() => Effect.void)),
          ),
        );
        return outcome;
      }).pipe(Effect.provide(KvStore.file(fs, root)));
      return result;
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

describe("durability", () => {
  it("a fresh repo over the same store sees the session (restart)", async () => {
    await withFileKv(async (kv) => {
      const first = new DoSessionRepo(kv);
      const session = await first.create({ id: "restart-me" });
      await session.appendMessage({
        content: [{ text: "hello", type: "text" }],
        role: "user",
        timestamp: Date.now(),
      });

      const second = new DoSessionRepo(kv);
      const metadata = await expectSession(second);
      expect(metadata.id).toBe("restart-me");
      const reopened = await second.open(metadata);
      const log = await reopened.getLog();
      expect(
        log.filter((item) => item.kind === "entry" && item.entry.type === "message"),
      ).toHaveLength(1);
    });
  });

  it("an open operation survives a restart (interrupted recovery)", async () => {
    await withFileKv(async (kv) => {
      const first = new DoSessionRepo(kv);
      const session = await first.create({ id: "interrupted-me" });
      await session.appendMessage({
        content: [{ text: "hi", type: "text" }],
        role: "user",
        timestamp: Date.now(),
      });
      // The agent's own operation record, as if the process died mid-run.
      const started = await session.appendRecord({
        id: "op-1",
        intent: { initialMessages: [], kind: "run", originalPrompt: [] },
        lane: "main",
        sourceLeafId: null,
        type: "operation_started",
      });

      const second = new DoSessionRepo(kv);
      const metadata = await expectSession(second);
      const reopened = await second.open(metadata);
      const open = await reopened.findOpenOperations("main", { limit: 1 });
      expect(open.map((o) => o.id)).toEqual([started.id]);
    });
  });

  it("load replays the log in seq order even when the store lists out of order", async () => {
    await withFileKv(async (kv) => {
      // Write the mutations directly, in scrambled order — a store that
      // lists keys arbitrarily (the file backend's readdir) must not
      // scramble the replay: the sequence numbers are the only order.
      const id = "scrambled";
      const put = async (seq: number, mutation: SessionMutation) => {
        await Effect.runPromise(
          kv.put(
            `${SessionPrefix.create(id)}${LogKey.create(seq)}`,
            new TextEncoder().encode(JSON.stringify(mutation)),
          ),
        );
      };
      await put(3, { fact: "name", kind: "fact", name: "third", seq: 3 });
      await put(1, {
        entry: {
          id: "u1",
          message: { content: [], role: "user", timestamp: 1 },
          parentId: null,
          seq: 1,
          timestamp: 1,
          type: "message",
        },
        kind: "entry",
      });
      await put(2, {
        entry: {
          id: "a1",
          message: assistantMessage(""),
          parentId: "u1",
          seq: 2,
          timestamp: 2,
          type: "message",
        },
        kind: "entry",
      });
      await Effect.runPromise(
        kv.put(
          `session/${id}/meta`,
          new TextEncoder().encode(JSON.stringify({ createdAt: 1, cwd: "", id })),
        ),
      );

      const repo = new DoSessionRepo(kv);
      const metadata = await expectSession(repo);
      const reopened = await repo.open(metadata);
      expect(await reopened.getName()).toBe("third");
      const replayed = await reopened.getLog();
      expect(replayed.map((item) => item.seq)).toEqual([1, 2, 3]);
    });
  });

  it("an imported pi trail replays and continues onto the last message", async () => {
    await withFileKv(async (kv) => {
      const repo = new DoSessionRepo(kv);
      // The mutation stream a pi session import produces: three entries, a
      // name fact, and the synthesized main-lane pin (pi-sessions).
      const imported = await repo.import("adopted-thread", {
        createdAt: 1_780_500_000_000,
        cwd: "/tmp/pi-workspace",
        mutations: [
          {
            entry: {
              id: "u1",
              message: {
                content: [{ text: "hi", type: "text" }],
                role: "user",
                timestamp: 1_780_500_000_001,
              },
              parentId: null,
              seq: 1,
              timestamp: 1_780_500_000_001,
              type: "message",
            },
            kind: "entry",
          },
          {
            entry: {
              id: "a1",
              message: assistantMessage("hello"),
              parentId: "u1",
              seq: 2,
              timestamp: 1_780_500_000_002,
              type: "message",
            },
            kind: "entry",
          },
          { fact: "name", kind: "fact", name: "adopted", seq: 3 },
          { kind: "lane", lane: "main", leafId: "a1", seq: 4 },
        ],
      });
      const importedMeta = await imported.getMetadata();
      expect(importedMeta.cwd).toBe("/tmp/pi-workspace");

      // The host opens the trail by thread id — the import must be visible
      // to a fresh repo as the thread's own session.
      const second = new DoSessionRepo(kv);
      const metadata = await expectSession(second);
      expect(metadata.id).toBe("adopted-thread");
      const reopened = await second.open(metadata);
      expect(await reopened.getName()).toBe("adopted");
      const log = await reopened.getLog();
      expect(log.filter((i) => i.kind === "entry")).toHaveLength(2);

      // Continuation chains onto the last imported message (the lane pin).
      const appended = await reopened.appendMessage({
        content: [{ text: "next", type: "text" }],
        role: "user",
        timestamp: Date.now(),
      });
      const lanes = await reopened.getLanes();
      const leaf = expectPresent(lanes[0], "the head lane");
      expect(leaf.leafId).toBe(appended);
      const tail = await reopened.getLog();
      const last = expectPresent(tail.at(-1), "the last log item");
      expect(last.kind === "entry" ? last.entry.parentId : null).toBe("a1");
    });
  });

  it("delete removes the session's keys", async () => {
    const kv = await buildKv(KvStore.memory());
    const repo = new DoSessionRepo(kv);
    const session = await repo.create({ id: "delete-me" });
    await session.appendMessage({
      content: [{ text: "x", type: "text" }],
      role: "user",
      timestamp: Date.now(),
    });
    const metadata = await expectSession(repo);
    await repo.delete(metadata);
    expect(await repo.list()).toEqual([]);
    // Idempotent.
    await repo.delete(metadata);
    expect(await repo.list()).toEqual([]);
  });

  it("load validates a torn log prefix is impossible: writes are atomic per key", async () => {
    const kv = await buildKv(KvStore.memory());
    const repo = new DoSessionRepo(kv);
    const session = await repo.create({ id: "atomic" });
    await session.appendMessage({
      content: [{ text: "one", type: "text" }],
      role: "user",
      timestamp: Date.now(),
    });
    await session.appendMessage({
      content: [{ text: "two", type: "text" }],
      role: "user",
      timestamp: Date.now(),
    });
    // A crash between mutations leaves a prefix: simulate by deleting the tail.
    const entries: readonly KvEntry[] = await Effect.runPromise(
      kv.list({ prefix: "session/atomic/log/" }),
    );
    let lastKey: KvEntry | undefined;
    for (const entry of entries) {
      if (lastKey === undefined || entry.key.localeCompare(lastKey.key) > 0) {
        lastKey = entry;
      }
    }
    if (lastKey === undefined) {
      throw new Error("expected a log key");
    }
    await Effect.runPromise(kv.delete(lastKey.key));
    const metadata = await expectSession(repo);
    // Replay must still load the remaining prefix.
    const reopened = await repo.open(metadata);
    const log = await reopened.getLog();
    expect(
      log.filter((item) => item.kind === "entry" && item.entry.type === "message"),
    ).toHaveLength(1);
  });
});
