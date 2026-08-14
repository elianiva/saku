/**
 * Hub registry tests: the durable thread index over the KvStore seam —
 * create/list/get/update/env axis/delete, the volatile state + tailSeq
 * caches, and persistence across registry rebuilds (the same code that
 * runs inside a Durable Object).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, FileSystem, Option } from "effect";

import { KvStore } from "@saku/store";
import { makeHubRegistry, type HubRegistryShape } from "../src/index.ts";

const run = <A, E extends Error>(effect: Effect.Effect<A, E, never>) =>
  Effect.runPromise(effect);

let registry: HubRegistryShape;
let home: string;

beforeEach(async () => {
  registry = await run(makeHubRegistry().pipe(Effect.provide(KvStore.memory())));
  home = "";
});

afterEach(async () => {
  if (home !== "") {
    await Effect.runPromise(
      Effect.provide(NodeFileSystem.layer)(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs
            .remove(home, { recursive: true, force: true })
            .pipe(Effect.catch(() => Effect.void));
        }),
      ),
    );
  }
});

describe("makeHubRegistry", () => {
  it("creates records with the env axis pinned by mode", async () => {
    const local = await run(registry.create({ name: "local thread" }));
    expect(local).toMatchObject({
      cwd: null,
      mode: "local",
      env: "ready",
      sessionId: null,
      autoName: false,
    });
    const sandbox = await run(registry.create({ name: "box thread", mode: "sandbox" }));
    expect(sandbox).toMatchObject({ cwd: null, mode: "sandbox", env: "stopped" });
    const withCwd = await run(
      registry.create({ name: "work thread", cwd: "/work", autoName: true }),
    );
    expect(withCwd).toMatchObject({ cwd: "/work", autoName: true });
  });

  it("lists in creation order and resolves by id", async () => {
    const a = await run(registry.create({ name: "a" }));
    const b = await run(registry.create({ name: "b" }));
    const list = await run(registry.list());
    expect(list.map((record) => record.id)).toEqual([a.id, b.id]);
    const got = await run(registry.get(a.id));
    expect(Option.getOrNull(got)?.id).toBe(a.id);
    expect(Option.isNone(await run(registry.get("nope")))).toBe(true);
  });

  it("projects the wire view with derived state and tailSeq", async () => {
    const record = await run(registry.create({ name: "t" }));
    const info = Option.getOrNull(await run(registry.toInfo(record.id)));
    expect(info).toMatchObject({ state: "idle", env: "ready", tailSeq: 0 });
    await run(registry.setState(record.id, "working"));
    await run(registry.setTailSeq(record.id, 7));
    const after = Option.getOrNull(await run(registry.toInfo(record.id)));
    expect(after).toMatchObject({ state: "working", tailSeq: 7 });
  });

  it("persists the env axis and sessionId across updates", async () => {
    const record = await run(registry.create({ name: "t", mode: "sandbox" }));
    await run(registry.setEnv(record.id, "provisioning"));
    await run(registry.setEnv(record.id, "ready"));
    await run(registry.update(record.id, { sessionId: "sess-1" }));
    const record2 = Option.getOrNull(await run(registry.get(record.id)));
    expect(record2).toMatchObject({ env: "ready", sessionId: "sess-1" });
  });

  it("deletes records and forgets their caches", async () => {
    const record = await run(registry.create({ name: "t" }));
    await run(registry.setState(record.id, "working"));
    expect(await run(registry.delete(record.id))).toBe(true);
    expect(await run(registry.delete(record.id))).toBe(false);
    expect(Option.isNone(await run(registry.get(record.id)))).toBe(true);
    expect(Option.isNone(await run(registry.toInfo(record.id)))).toBe(true);
  });

  it("survives a rebuild over the file backend (restart persistence)", async () => {
    const { fs, dir } = await Effect.runPromise(
      Effect.provide(NodeFileSystem.layer)(
        Effect.gen(function* () {
          const f = yield* FileSystem.FileSystem;
          const d = yield* f.makeTempDirectory({ prefix: "saku-hub-registry-" });
          return { fs: f, dir: d };
        }),
      ),
    );
    home = dir;
    const runFile = <A, E>(effect: Effect.Effect<A, E, KvStore>) =>
      run(effect.pipe(Effect.provide(KvStore.file(fs, home))));
    const first = await runFile(makeHubRegistry());
    const record = await run(first.create({ name: "durable", cwd: "/work", autoName: true }));
    await run(first.setEnv(record.id, "ready"));
    await run(first.update(record.id, { sessionId: "sess-9" }));
    // A fresh registry over the same store sees the same records.
    const second = await runFile(makeHubRegistry());
    const reloaded = Option.getOrNull(await run(second.get(record.id)));
    expect(reloaded).toMatchObject({
      name: "durable",
      cwd: "/work",
      autoName: true,
      env: "ready",
      sessionId: "sess-9",
    });
    // Volatile caches start fresh.
    const info = Option.getOrNull(await run(second.toInfo(record.id)));
    expect(info).toMatchObject({ state: "idle", tailSeq: 0 });
  });
});
