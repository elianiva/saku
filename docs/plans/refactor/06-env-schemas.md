# Plan — 06 · Env package: Match dispatch, EnvHandle schema, describeEntry composition

Status: **planned** — parallel plan 06 of the refactor pass (see `README.md`).

## Owned files

- `packages/env/src/daemon.ts`
- `packages/env/src/protocol.ts`
- `packages/env/src/local-env.ts`
- `packages/env/test/env-daemon.test.ts`

## Problem

1. `daemon.ts` `runOp` (~lines 70-190) is a 20-case `switch (op._tag)` with a
   hand-rolled `default: { const exhaustive: never = op; }` — `Match.tagsExhaustive`
   gives the check for free (review P3-8). (This function returns Promises because
   it serves pi's `ExecutionEnv` contract — that stays; only the dispatch changes.)
2. `EnvHandle` (`protocol.ts:190-215`) is a plain TS interface, yet it is saku's own
   persisted contract — it crosses the `/set-env-handle` RPC and DO storage
   unvalidated (review P4-12).
3. `local-env.ts` `describeEntry` (~lines 90-115) runs two sequential
   `Effect.runPromise`s — compose into one Effect, cross the promise boundary once
   (review P1-4's last bullet).

## Design

### 1. `runOp` → `Match.tagsExhaustive`

```ts
const runOp = (env, id, op, ctx): Promise<…> =>
  Match.value(op).pipe(
    Match.tagsExhaustive({
      health: () => Promise.resolve({ ok: true, payload: { cwd: ctx.cwd, pid: ctx.pid, version: ENV_VERSION } }),
      absolute_path: ({ path }) => run<string, FileError>(env.absolutePath(path)),
      join_path: ({ parts }) => run<string, FileError>(env.joinPath([...parts])),
      read_text_file: ({ path }) => run<string, FileError>(env.readTextFile(path)),
      read_text_lines: ({ path, maxLines }) => run<string[], FileError>(…),
      read_binary_file: ({ path }) => …,        // keep the base64 .then mapping
      write_file: ({ path, content, encoding }) => …,  // keep Buffer decode
      append_file: ({ path, content, encoding }) => …,
      rename_file: ({ sourcePath, destinationPath }) => …,
      file_info: ({ path }) => …,
      list_dir: ({ path }) => …,
      canonical_path: ({ path }) => …,
      exists: ({ path }) => …,
      create_dir: ({ path, recursive }) => …,
      remove: ({ path, recursive, force }) => …,
      create_temp_dir: ({ prefix }) => …,
      create_temp_file: ({ prefix, suffix }) => …,
      exec: ({ command, cwd, env, timeout, inheritEnv }) => { …same body… },
    }),
  );
```

No `default` arm. Delete the `exhaustive` variable. The `run` helper and the
abort-controller registration stay as-is. Note: `Match.tagsExhaustive` handlers
receive the narrowed payload — the `op.path`-style field accesses become destructured
params, which also removes ~20 property lookups.

### 2. `EnvHandle` as Schema

`protocol.ts`:

```ts
export const EnvHandle = Schema.Struct({
  url: Schema.String,
  token: Schema.String,
  boxId: Schema.Union([Schema.Null, Schema.String]),
  relay: Schema.optional(Schema.Struct({ envId: Schema.String, token: Schema.String })),
});
export type EnvHandle = Schema.Schema.Type<typeof EnvHandle>;
```

This is **ripple-free by construction**: every consumer
(`hub/registry.ts` — plan 01, `deploy/thread-do.ts` — plan 02, `hub/box.ts`/
`provisioner.ts` — plan 04, `cli/env.ts` — plan 07) imports `type EnvHandle`, which
resolves to the same shape. Do not touch any of those files. The RPC boundary in
`thread-do.ts` (plan 02's file) still casts the incoming JSON — leave it; plan 02
already owns that seam, and the schema here is what makes a later decode possible.

### 3. `describeEntry` single composition

```ts
const describeEntry = (fs: FileSystem.FileSystem, path: string): Promise<FileInfo> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const isLink = yield* Effect.isSuccess(fs.readLink(path));
      if (isLink) return { name: path.split(sep).pop() ?? path, path, kind: "symlink" as const, size: 0, mtimeMs: 0 };
      const info = yield* fs.stat(path).pipe(Effect.catch(() => Effect.succeed(undefined)));
      if (info === undefined) return { name: …, path, kind: "file" as const, size: 0, mtimeMs: 0 };
      return { name: …, path, kind: info.type === "Directory" ? ("directory" as const) : ("file" as const), size: Number(info.size), mtimeMs: Option.isSome(info.mtime) ? info.mtime.value.getTime() : 0 };
    }),
  );
```

One boundary crossing per call instead of two. Keep the exact return values (the
`EnvFileInfo` wire shape in `protocol.ts` depends on them).

## Steps

1. `protocol.ts`: schema-ify `EnvHandle` (add the Schema + type alias, update the doc
   comment to mention it is the persisted handle contract).
2. `daemon.ts`: `runOp` → Match per design. Import `Match` from `effect`.
3. `local-env.ts`: `describeEntry` per design.
4. `env-daemon.test.ts`: run unchanged; if it imports `EnvHandle` as a value, it now
   gets the Schema (unlikely — it imports the type; verify).
5. Run the env suite; also `pnpm --filter @saku/hub test` (relay tests use the env
   daemon over real sockets) and `pnpm --filter @saku/worker test` (remote-host tests
   drive `RemoteEnv` against `makeEnvDaemon`) must stay green.

## References

- Match idiom: lutra `packages/frontend/src/editor/update.ts:218`; foldkit
  `packages/typing-game/client/src/page/home/update/update.ts`.
- The two existing `Match`-less exhaustiveness patterns being replaced: see
  `daemon.ts` `runOp` default arm vs. the wire client's `handleFrame` switch
  (`packages/wire/src/client.ts` — read for contrast, not owned here).
- Schema-typed persisted contracts: the env protocol itself —
  `protocol.ts` `EnvHello`/`EnvRequest`/`EnvOp` — is already fully schema-typed;
  `EnvHandle` is the one straggler.
- Single-boundary-crossing composition: opencode `packages/core/src/fs-util.ts`
  (compose effects, `runPromise` once at the promise seam) and
  `packages/env/src/local-env.ts`'s own doc header ("failures captured with
  Effect.result, never try/catch").

## Verification

```sh
pnpm --filter @saku/env typecheck && pnpm --filter @saku/env test
pnpm --filter @saku/hub test
pnpm --filter @saku/worker test
```

## Definition of done

- `runOp` is a `Match.tagsExhaustive` with no default arm.
- `EnvHandle` is a Schema; `EnvHandle` type consumers compile untouched.
- `describeEntry` performs one `Effect.runPromise` per call.
- Env suite + dependent suites green; no files outside the owned list edited.
