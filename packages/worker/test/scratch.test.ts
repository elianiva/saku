import { NodeFileSystem } from "@effect/platform-node";
import { Context, Effect, FileSystem, Layer } from "effect";
import { describe, expect, it } from "vitest";

class Paths extends Context.Service<Paths, { root: string }>()("Paths") {}
class Registry extends Context.Service<Registry, { list: () => Effect.Effect<string[]> }>()("Registry") {}

const PathsTest: Layer.Layer<Paths, never, FileSystem.FileSystem> = Layer.effect(
  Paths,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return { root: "x" };
  }),
);

const RegistryTest: Layer.Layer<Registry, never, FileSystem.FileSystem> = Layer.succeed(Registry, {
  list: () => Effect.succeed(["a"]),
}).pipe(Layer.provide(PathsTest));
const run1 = (body: Effect.Effect<string, never, FileSystem.FileSystem | Paths>) =>
  Effect.runPromise(
    Effect.provide(NodeFileSystem.layer)(
      Effect.provide(RegistryTest)(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const p = yield* Paths;
          return `${fs !== undefined} ${p.root}`;
        }),
      ),
    ),
  );

describe("repro", () => {
  it("body sees FileSystem and Paths", async () => {
    const out = await run1();
    console.log("OUT1:", out);
    expect(out).toBe("true x");
  });

  it("layer build sees FileSystem when provided outside", async () => {
    const out = await Effect.runPromise(
      Effect.provide(NodeFileSystem.layer)(
        Effect.provide(RegistryTest)(
          Effect.gen(function* () {
            const r = yield* Registry;
            return yield* r.list();
          }),
        ),
      ),
    );
    expect(out).toEqual(["a"]);
  });

  it("pipe-order provides: body sees FileSystem", async () => {
    const out = await Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const p = yield* Paths;
      return `${fs !== undefined} ${p.root}`;
    }).pipe(Effect.provide(NodeFileSystem.layer), Effect.provide(PathsTest));
    console.log("OUT2:", await Effect.runPromise(out));
  });
});
