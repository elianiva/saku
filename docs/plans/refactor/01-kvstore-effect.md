# Plan — 01 · Effect-ify the KvStore seam

Status: **planned** — parallel plan 01 of the refactor pass (see `README.md`).

## Owned files

- `packages/store/src/kv.ts` (+ read `fs.ts`, `index.ts` — exports only)
- `packages/worker/src/do-session.ts`
- `packages/hub/src/registry.ts`
- `packages/hub/src/skills.ts`
- `packages/deploy/src/kv.ts`
- `packages/worker/test/do-session.test.ts`, `packages/hub/test/registry.test.ts`

Do **not** touch any other file (see ownership table in `README.md`). In particular:
`worker/src/session-host.ts` only imports the `KvStore` **type** — no edit needed there.

## Problem

`KvStore` — saku's _own_ storage contract (`store/src/kv.ts:24-29`) — is promise-shaped:
`get/put/delete/list → Promise`. That mirrors DO storage, but it inverts the project's
promise rule ("promise only at the pi-agent-core seam"): saku-side consumers
(`hub/registry.ts`, `hub/skills.ts`) wrap every call in `Effect.tryPromise`, while the
effect-side implementation (`fileKv`) wraps every call in `Effect.runPromise` —
two directions of boundary-crossing for one interface.

The code-judo: make `KvStore` effect-based **and service-shaped** (the elianiva.com
`KvCache` pattern: a `Context.Service` class whose backends are static layer
factories). `do-session.ts` — which implements **pi's** `SessionStorage`/`SessionRepo`
promise contract — is the one true promise seam and does the single
`Effect.runPromise` crossing per method. Everything else loses its wrappers and its
constructor-arg plumbing: consumers `yield* KvStore`, and each composition site
provides the backend layer at the boundary.

## Design

The `KvStore` service (in `store/src/kv.ts`):

```ts
export class KvStore extends Context.Service<KvStore, KvStoreShape>()("KvStore") {
  static memory(): Layer.Layer<KvStore>               // in-memory (tests, daemons)
  static file(fs: FileSystem.FileSystem, root: string): Layer.Layer<KvStore>
  static doStorage(storage: DoStorageLike): Layer.Layer<KvStore>  // DO storage
}

export interface KvStoreShape {
  readonly get: (key: string) => Effect.Effect<Uint8Array | undefined, never>;
  readonly put: (key: string, value: Uint8Array) => Effect.Effect<void, never>;
  readonly delete: (key: string) => Effect.Effect<void, never>;
  readonly list: (options: { prefix: string }) => Effect.Effect<readonly KvEntry[], never>;
}
```

Notes:

- Error channel `never`: the memory backend cannot fail; the file backend swallows fs errors
  per-call (`catchEager` everywhere) and `listFiles` returns `never` already.
  Keep that semantic — this seam's failure posture is "storage defects kill the
  caller", which is also what DO storage does.
- Backends are built lazily (`Layer.sync`) and fresh per build, so two provides never
  share state. Each backend's implementation lives inline in its static
  factory (the `KvCache.layerFrom` shape); only pure helpers (`encode`,
  `keyPath`, `listFiles`, `dirname`) sit at module level, and the shape is
  what flows through value-typed seams (`KvStoreShape`).
- The DO adapter (`DoStorageLike`) moves from `deploy/src/kv.ts` into
  `store/src/kv.ts` (the seam's home) — `deploy/src/kv.ts` is deleted.
- **Parallelize `listFiles` while you're in it** (review finding): the `for (const
name of names)` recursive loop serializes independent directory
  entries. Use `Effect.forEach(names, (name) => …, { concurrency: "unbounded" })` +
  `Effect.map(Array.flatten)`; keep the recursion shape or flatten into one level.

## Steps

### 1. `packages/store/src/kv.ts`

Rewrite as the service with the three backend implementations inline in their
statics per the design. Keep `KvEntry`,
`encode`, `keyPath`, `isNotFound` re-export from `fs.ts`, and the memory backend's
value-copying behavior (`new Uint8Array(value)`). Update the header comment: "the promise boundary
is the pi seam (`do-session.ts`), not here".

### 2. `packages/hub/src/registry.ts`

`makeHubRegistry()` takes no kv argument; the gen does `const kv = yield* KvStore`
(R becomes `KvStore`). In `persist` and `load`: delete the `Effect.tryPromise({try: () =>
kv.put/list…, catch: toHubError(…)})` wrappers — `yield* kv.put(...)` directly.
`load`'s corrupt-record
skip is `Effect.try({ try: () => decodeRecord(entry.value), catch: … }).pipe(
Effect.catch(() => Effect.succeed(undefined)))`-style (keep the console.warn, keep
"skip, key stays on disk" semantics). `Effect.forEach` over entries.

### 3. `packages/hub/src/skills.ts`

Same treatment: `makeSkillsStore`'s `Effect.tryPromise({ try: async () => {…} })`
load loop → `Effect.gen` over `yield* kv.list(...)`. The rest of the store (import
logic, `encodeSkill`/`decodeSkill`) is unchanged.

### 4. `packages/worker/src/do-session.ts`

This file implements pi's promise contract — it stays promise-based **outside** and
does the crossing **once per method**:

- Replace every `await this.kv.get(...)` / `await this.kv.put(...)` with
  `await Effect.runPromise(this.kv.get(...))` etc.
- The classes stay **value-shaped**: `DoSessionStorage.create/load`, the
  `DoSessionRepo` constructor, and `prefixedKv` take `KvStoreShape` (the service's
  shape type) — the class hands the value in from whoever `yield* KvStore`'d it
  (`SessionHost.create`).
- `DoSessionStorage.create/load` are `static async` (pi's `SessionStorage` shape) —
  keep them async; inside, `runPromise` the kv calls.
- The `private tail: Promise<unknown>` mutation serializer stays as-is: it exists to
  satisfy pi's sequence-number contract (mirrors `JsonlSessionStorage`), it is the
  pi seam, and `Effect` would not make it clearer.
- `parseMutation`: keep the try/catch → `SessionError` (pi's own error
  type must cross here; the `as SessionMutation` cast is pi's mutation vocabulary —
  plan 05 does not change `session-state.ts`, so leave it).

### 5. `packages/deploy`

`deploy/src/kv.ts` is **deleted**: `DoStorageLike` and the DO adapter move into
`store/src/kv.ts` as the service's `doStorage` backend (inline in the static). `hub-do.ts` provides
`KvStore.doStorage(state.storage)` around `makeHub`; `thread-do.ts` drops its `kv`
field and provides the same layer around `SessionHost.create`.

### 6. `packages/worker/src/{session-host,daemon}.ts`

- `SessionHostOptions` loses `kv`; `SessionHost.create` does `const kv = yield* KvStore`
  (R becomes `KvStore`) and hands the value to `DoSessionRepo`.
- The daemon provides the file-backed layer per host: `SessionHost.create(...).pipe(
  Effect.provide(KvStore.file(fs, getThreadTrailRoot(threadId))))`.

### 7. Tests

- `packages/worker/test/do-session.test.ts`: direct `kv.get(...)`/`kv.put(...)`
  calls (assertions about stored bytes) are now Effects — wrap in `Effect.runPromise`
  in the test or `yield*` them inside existing gens. A `buildKv(layer)` helper turns
  a backend layer into the shape value the pi seam classes take.
- `packages/hub/test/registry.test.ts`: `makeHubRegistry().pipe(Effect.provide(
  KvStore.memory()))`; the file-backend rebuild test provides `KvStore.file(fs, home)`.
- `session-host.test.ts`, `remote-host.test.ts`, and the hub suites provide
  `KvStore.memory()` / `KvStore.file(...)` instead of passing constructors.

## References

- Round-trip-avoidance: opencode `AGENTS.md` ("Do not return Effect from helpers
  unless they actually perform effectful work"; promises confined to
  `Effect.tryPromise` bridges) and `packages/core/src/effect/bridge.ts`.
- Parallel traversal: opencode `packages/core/src/fs-util.ts` / `git.ts` use
  `Effect.all`/`forEach` with `{ concurrency: "unbounded" }` for independent reads.
- Boundary crossing style: lutra `packages/frontend/src/encode/worker-layer.ts`
  (promise bridge → `Deferred`/`Effect.runFork`) and opencode
  `packages/opencode/src/effect/bridge.ts` (runPromise only at the process edge).

## Verification

```sh
pnpm --filter @saku/store typecheck && pnpm --filter @saku/store test
pnpm --filter @saku/worker typecheck && pnpm --filter @saku/worker test
pnpm --filter @saku/hub typecheck && pnpm --filter @saku/hub test
pnpm --filter @saku/deploy typecheck
```

(Deploy tests use bun: `pnpm --filter @saku/deploy test`.)

## Definition of done

- `KvStore` is an Effect `Context.Service` with `memory`/`file`/`doStorage` layer
  factories; consumers `yield* KvStore`; `grep -n "tryPromise"
packages/hub/src/registry.ts packages/hub/src/skills.ts` returns nothing;
  `grep -n "runPromise" packages/store/src/kv.ts` returns nothing.
- No `memoryKv`/`fileKv`/`doStorageKv` functions remain — the backends live
  inline in the `KvStore` statics; the shape travels as `KvStoreShape`;
  `deploy/src/kv.ts` is gone.
- `do-session.ts` still satisfies pi's conformance (`SessionBackendConformance` in
  `worker/test/do-session.test.ts`) — all tests green.
- `listFiles` no longer serializes entries.
- No file edited outside the owned list.
