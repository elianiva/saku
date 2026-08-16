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
import { HubRegistry } from "../src/index.ts";
import type { HubRegistryApi } from "../src/index.ts";

let registry: HubRegistryApi;
let home: string;

beforeEach(async () => {
  registry = await Effect.runPromise(HubRegistry.make().pipe(Effect.provide(KvStore.memory())));
  home = "";
});

afterEach(async () => {
  if (home !== "") {
    await Effect.runPromise(
      Effect.provide(NodeFileSystem.layer)(
        Effect.gen(function* cleanup() {
          const fs = yield* FileSystem.FileSystem;
          yield* fs
            .remove(home, { force: true, recursive: true })
            .pipe(Effect.catch(() => Effect.void));
        }),
      ),
    );
  }
});

describe("HubRegistry.make", () => {
  it("creates records with the env axis pinned by mode", async () => {
    const local = await Effect.runPromise(registry.create({ name: "local thread" }));
    expect(local).toMatchObject({
      autoName: false,
      cwd: null,
      env: "ready",
      mode: "local",
      sessionId: null,
    });
    const sandbox = await Effect.runPromise(
      registry.create({ mode: "sandbox", name: "box thread" }),
    );
    expect(sandbox).toMatchObject({ cwd: null, env: "stopped", mode: "sandbox" });
    const withCwd = await Effect.runPromise(
      registry.create({ autoName: true, cwd: "/work", name: "work thread" }),
    );
    expect(withCwd).toMatchObject({ autoName: true, cwd: "/work" });
  });

  it("lists in creation order and resolves by id", async () => {
    const a = await Effect.runPromise(registry.create({ name: "a" }));
    const b = await Effect.runPromise(registry.create({ name: "b" }));
    const list = await Effect.runPromise(registry.list());
    expect(list.map((record) => record.id)).toEqual([a.id, b.id]);
    const got = await Effect.runPromise(registry.get(a.id));
    expect(Option.getOrNull(got)?.id).toBe(a.id);
    expect(Option.isNone(await Effect.runPromise(registry.get("nope")))).toBe(true);
  });

  it("projects the wire view with derived state and tailSeq", async () => {
    const record = await Effect.runPromise(registry.create({ name: "t" }));
    const info = Option.getOrNull(await Effect.runPromise(registry.toInfo(record.id)));
    expect(info).toMatchObject({ env: "ready", state: "idle", tailSeq: 0 });
    await Effect.runPromise(registry.setState(record.id, "working"));
    await Effect.runPromise(registry.setTailSeq(record.id, 7));
    const after = Option.getOrNull(await Effect.runPromise(registry.toInfo(record.id)));
    expect(after).toMatchObject({ state: "working", tailSeq: 7 });
  });

  it("persists the env axis and sessionId across updates", async () => {
    const record = await Effect.runPromise(registry.create({ mode: "sandbox", name: "t" }));
    await Effect.runPromise(registry.setEnv(record.id, "provisioning"));
    await Effect.runPromise(registry.setEnv(record.id, "ready"));
    await Effect.runPromise(registry.update(record.id, { sessionId: "sess-1" }));
    const record2 = Option.getOrNull(await Effect.runPromise(registry.get(record.id)));
    expect(record2).toMatchObject({ env: "ready", sessionId: "sess-1" });
  });

  it("deletes records and forgets their caches", async () => {
    const record = await Effect.runPromise(registry.create({ name: "t" }));
    await Effect.runPromise(registry.setState(record.id, "working"));
    expect(await Effect.runPromise(registry.delete(record.id))).toBe(true);
    expect(await Effect.runPromise(registry.delete(record.id))).toBe(false);
    expect(Option.isNone(await Effect.runPromise(registry.get(record.id)))).toBe(true);
    expect(Option.isNone(await Effect.runPromise(registry.toInfo(record.id)))).toBe(true);
  });

  it("survives a rebuild over the file backend (restart persistence)", async () => {
    const { fs, dir } = await Effect.runPromise(
      Effect.provide(NodeFileSystem.layer)(
        Effect.gen(function* buildWorld() {
          const f = yield* FileSystem.FileSystem;
          const d = yield* f.makeTempDirectory({ prefix: "saku-hub-registry-" });
          return { dir: d, fs: f };
        }),
      ),
    );
    home = dir;
    const first = await Effect.runPromise(
      HubRegistry.make().pipe(Effect.provide(KvStore.file(fs, home))),
    );
    const record = await Effect.runPromise(
      first.create({ autoName: true, cwd: "/work", name: "durable" }),
    );
    await Effect.runPromise(first.setEnv(record.id, "ready"));
    await Effect.runPromise(first.update(record.id, { sessionId: "sess-9" }));
    // A fresh registry over the same store sees the same records.
    const second = await Effect.runPromise(
      HubRegistry.make().pipe(Effect.provide(KvStore.file(fs, home))),
    );
    const reloaded = Option.getOrNull(await Effect.runPromise(second.get(record.id)));
    expect(reloaded).toMatchObject({
      autoName: true,
      cwd: "/work",
      env: "ready",
      name: "durable",
      sessionId: "sess-9",
    });
    // Volatile caches start fresh.
    const info = Option.getOrNull(await Effect.runPromise(second.toInfo(record.id)));
    expect(info).toMatchObject({ state: "idle", tailSeq: 0 });
  });
});
