/**
 * DoSessionRepo tests: pi's own backend conformance suite (both memory and
 * file KvStores) plus the durability properties the worker relies on:
 * a crash leaves a prefix of the log, and a restart replays it.
 */

import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, FileSystem, Layer } from "effect";
import {
  createSessionBackendConformance,
  type SessionBackendFixture,
} from "@earendil-works/pi-agent-core/session/testing";

import { DoSessionRepo, DoSessionStorage } from "../src/do-session.ts";
import { KvStore, type KvStoreShape } from "@saku/store";

/** Build a KvStore value from a backend layer (the pi seam is value-shaped). */
const buildKv = (layer: Layer.Layer<KvStore>): Promise<KvStoreShape> =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* KvStore;
    }).pipe(Effect.provide(layer)),
  );

/** Run pi's conformance cases as vitest cases. */
const runConformance = (label: string, factory: () => Promise<SessionBackendFixture>): void => {
  describe(`${label} conformance`, () => {
    for (const testCase of createSessionBackendConformance(factory)) {
      it(`${testCase.group}: ${testCase.name}`, async () => {
        await testCase.run();
      });
    }
  });
};

const memoryFixture = async (): Promise<SessionBackendFixture> => ({
  repository: new DoSessionRepo(await buildKv(KvStore.memory())),
  [Symbol.asyncDispose]: async () => {},
});

runConformance("memoryKv", memoryFixture);

// The file-backed fixture needs the FileSystem service; build its factory
// once inside a provided context (each case still gets a fresh temp dir).
const fileFixtureFactory = await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return async (): Promise<SessionBackendFixture> => {
      const root = await Effect.runPromise(fs.makeTempDirectory({ prefix: "saku-trail-" }));
      const kv = await buildKv(KvStore.file(fs, root));
      return {
        repository: new DoSessionRepo(kv),
        [Symbol.asyncDispose]: async () => {
          await Effect.runPromise(
            fs.remove(root, { recursive: true, force: true }).pipe(Effect.catch(() => Effect.void)),
          );
        },
      };
    };
  }).pipe(Effect.provide(NodeFileSystem.layer)),
);

runConformance("fileKv", fileFixtureFactory);

describe("durability", () => {
  const withFileKv = <A>(
    run: (kv: KvStoreShape, fs: FileSystem.FileSystem) => Promise<A>,
  ): Promise<A> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectory({ prefix: "saku-durability-" });
        return yield* Effect.gen(function* () {
          const kv = yield* KvStore;
          return yield* Effect.tryPromise(() => run(kv, fs)).pipe(
            Effect.ensuring(
              fs
                .remove(root, { recursive: true, force: true })
                .pipe(Effect.catch(() => Effect.void)),
            ),
          );
        }).pipe(Effect.provide(KvStore.file(fs, root)));
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    );

  it("a fresh repo over the same store sees the session (restart)", async () => {
    await withFileKv(async (kv) => {
      const first = new DoSessionRepo(kv);
      const session = await first.create({ id: "restart-me" });
      await session.appendMessage({
        role: "user",
        content: [{ type: "text", text: "hello" }],
        timestamp: Date.now(),
      });

      const second = new DoSessionRepo(kv);
      const [metadata] = await second.list();
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
        role: "user",
        content: [{ type: "text", text: "hi" }],
        timestamp: Date.now(),
      });
      // The agent's own operation record, as if the process died mid-run.
      const started = await session.appendRecord({
        type: "operation_started",
        id: "op-1",
        lane: "main",
        sourceLeafId: null,
        intent: { kind: "run", originalPrompt: [], initialMessages: [] },
      });

      const second = new DoSessionRepo(kv);
      const [metadata] = await second.list();
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
      const put = (seq: number, mutation: unknown): Promise<void> =>
        Effect.runPromise(
          kv.put(`session/${id}/log/${String(seq).padStart(12, "0")}`, new TextEncoder().encode(JSON.stringify(mutation))),
        );
      await put(3, { kind: "fact", seq: 3, fact: "name", name: "third" });
      await put(1, {
        kind: "entry",
        entry: {
          type: "message",
          id: "u1",
          parentId: null,
          seq: 1,
          timestamp: 1,
          message: { role: "user", content: [], timestamp: 1 },
        },
      });
      await put(2, {
        kind: "entry",
        entry: {
          type: "message",
          id: "a1",
          parentId: "u1",
          seq: 2,
          timestamp: 2,
          message: { role: "assistant", content: [], timestamp: 2 },
        },
      });
      await Effect.runPromise(
        kv.put(`session/${id}/meta`, new TextEncoder().encode(JSON.stringify({ id, createdAt: 1, cwd: "" }))),
      );

      const repo = new DoSessionRepo(kv);
      const [metadata] = await repo.list();
      const reopened = await repo.open(metadata);
      expect(await reopened.getName()).toBe("third");
      expect((await reopened.getLog()).map((item) => item.seq)).toEqual([1, 2, 3]);
    });
  });

  it("an imported pi trail replays and continues onto the last message", async () => {
    await withFileKv(async (kv) => {
      const repo = new DoSessionRepo(kv);
      // The mutation stream a pi session import produces: three entries, a
      // name fact, and the synthesized main-lane pin (pi-sessions.ts).
      const imported = await repo.import("adopted-thread", {
        cwd: "/tmp/pi-workspace",
        createdAt: 1780500000000,
        mutations: [
          {
            kind: "entry",
            entry: {
              type: "message",
              id: "u1",
              parentId: null,
              seq: 1,
              timestamp: 1780500000001,
              message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1780500000001 },
            },
          },
          {
            kind: "entry",
            entry: {
              type: "message",
              id: "a1",
              parentId: "u1",
              seq: 2,
              timestamp: 1780500000002,
              message: { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 1780500000002 },
            },
          },
          { kind: "fact", seq: 3, fact: "name", name: "adopted" },
          { kind: "lane", seq: 4, lane: "main", leafId: "a1" },
        ],
      });
      expect((await imported.getMetadata()).cwd).toBe("/tmp/pi-workspace");

      // The host opens the trail by thread id — the import must be visible
      // to a fresh repo as the thread's own session.
      const second = new DoSessionRepo(kv);
      const [metadata] = await second.list();
      expect(metadata.id).toBe("adopted-thread");
      const reopened = await second.open(metadata);
      expect(await reopened.getName()).toBe("adopted");
      expect((await reopened.getLog()).filter((i) => i.kind === "entry")).toHaveLength(2);

      // Continuation chains onto the last imported message (the lane pin).
      const appended = await reopened.appendMessage({
        role: "user",
        content: [{ type: "text", text: "next" }],
        timestamp: Date.now(),
      });
      const [leaf] = await reopened.getLanes();
      expect(leaf.leafId).toBe(appended);
      const [last] = (await reopened.getLog()).slice(-1);
      expect(last.kind === "entry" ? last.entry.parentId : null).toBe("a1");
    });
  });

  it("delete removes the session's keys", async () => {
    const kv = await buildKv(KvStore.memory());
    const repo = new DoSessionRepo(kv);
    const session = await repo.create({ id: "delete-me" });
    await session.appendMessage({
      role: "user",
      content: [{ type: "text", text: "x" }],
      timestamp: Date.now(),
    });
    const [metadata] = await repo.list();
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
      role: "user",
      content: [{ type: "text", text: "one" }],
      timestamp: Date.now(),
    });
    await session.appendMessage({
      role: "user",
      content: [{ type: "text", text: "two" }],
      timestamp: Date.now(),
    });
    // A crash between mutations leaves a prefix: simulate by deleting the tail.
    const keys = [...(await Effect.runPromise(kv.list({ prefix: "session/atomic/log/" })))];
    const last = keys.sort((a, b) => a.key.localeCompare(b.key)).at(-1)!;
    await Effect.runPromise(kv.delete(last.key));
    const [metadata] = await repo.list();
    // Replay must still load the remaining prefix.
    const reopened = await repo.open(metadata);
    const log = await reopened.getLog();
    expect(
      log.filter((item) => item.kind === "entry" && item.entry.type === "message"),
    ).toHaveLength(1);
  });
});
