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

`KvStore` — saku's *own* storage contract (`store/src/kv.ts:24-29`) — is promise-shaped:
`get/put/delete/list → Promise`. That mirrors DO storage, but it inverts the project's
promise rule ("promise only at the pi-agent-core seam"): saku-side consumers
(`hub/registry.ts`, `hub/skills.ts`) wrap every call in `Effect.tryPromise`, while the
effect-side implementation (`fileKv`) wraps every call in `Effect.runPromise` —
two directions of boundary-crossing for one interface.

The code-judo: make `KvStore` effect-based. `do-session.ts` — which implements **pi's**
`SessionStorage`/`SessionRepo` promise contract — is the one true seam and does the
single `Effect.runPromise` crossing per method. Everything else loses its wrappers.

## Design

New `KvStore` (in `store/src/kv.ts`):

```ts
export interface KvStore {
  readonly get: (key: string) => Effect.Effect<Uint8Array | undefined, never>;
  readonly put: (key: string, value: Uint8Array) => Effect.Effect<void, never>;
  readonly delete: (key: string) => Effect.Effect<void, never>;
  readonly list: (options: { prefix: string }) => Effect.Effect<readonly KvEntry[], never>;
}
```

Notes:
- Error channel `never`: `memoryKv` cannot fail; `fileKv` currently swallows fs errors
  per-call anyway (`catchEager` everywhere) and `listFiles` returns `never` already.
  Keep that semantic — this seam's failure posture is "storage defects kill the
  caller", which is also what DO storage does.
- `memoryKv()`: drop `async`, return the Effects directly (`Effect.succeed(map.get(key))` etc.).
- `fileKv`: delete every `Effect.runPromise` wrapper — the methods *are* Effects now.
  `put` becomes the existing `Effect.gen`; `list` becomes `listFiles(...).pipe(flatMap(...))`.
- `deploy/src/kv.ts` `doStorageKv`: adapts DO storage. Each method wraps the DO's
  promise in `Effect.tryPromise`/`Effect.promise` — the platform boundary, mirroring
  what `hub/registry.ts` does today (see `toHubError` there for the wrap style).
- **Parallelize `listFiles` while you're in it** (review finding): the `for (const
  name of names)` recursive loop (~kv.ts:60-80) serializes independent directory
  entries. Use `Effect.forEach(names, (name) => …, { concurrency: "unbounded" })` +
  `Effect.map(Array.flatten)`; keep the recursion shape or flatten into one level.

## Steps

### 1. `packages/store/src/kv.ts`

Rewrite the interface + both implementations per the design. Keep `KvEntry`, `encode`,
`keyPath`, `isNotFound` re-export from `fs.ts`, and `memoryKv`'s value-copying
behavior (`new Uint8Array(value)`). Update the header comment: "the promise boundary
is the pi seam (`do-session.ts`), not here".

### 2. `packages/hub/src/registry.ts`

In `persist` (~line 96) and `load` (~line 108): delete the `Effect.tryPromise({try: () =>
kv.put/list…, catch: toHubError(…)})` wrappers — `yield* kv.put(...)` directly.
`load`'s inner `async () => { … }` becomes a plain `Effect.gen` with the corrupt-record
skip as `Effect.try({ try: () => decodeRecord(entry.value), catch: … }).pipe(
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
- `DoSessionStorage.create/load` are `static async` (pi's `SessionStorage` shape) —
  keep them async; inside, `runPromise` the kv calls.
- The `private tail: Promise<unknown>` mutation serializer stays as-is: it exists to
  satisfy pi's sequence-number contract (mirrors `JsonlSessionStorage`), it is the
  pi seam, and `Effect` would not make it clearer.
- `parseMutation` (~line 73): keep the try/catch → `SessionError` (pi's own error
  type must cross here; the `as SessionMutation` cast is pi's mutation vocabulary —
  plan 05 does not change `session-state.ts`, so leave it).

### 5. `packages/deploy/src/kv.ts`

`doStorageKv` returns the new Effect-shaped `KvStore`: each method wraps the DO
storage promise in `Effect.tryPromise` (no error mapping needed — channel is `never`:
use `Effect.promise(() => state.storage.get(key))` and let defects carry; or
`Effect.tryPromise` with a plain rethrow — pick one, note the choice in a comment).

### 6. Tests

- `packages/worker/test/do-session.test.ts`: any direct `kv.get(...)`/`kv.put(...)`
  calls (assertions about stored bytes) are now Effects — wrap in `Effect.runPromise`
  in the test or `yield*` them inside existing gens.
- `packages/hub/test/registry.test.ts`: same for any direct kv calls used to seed or
  assert storage.
- `session-host.test.ts`, `remote-host.test.ts`, and the hub tests that pass
  `fileKv(…)`/`memoryKv()` constructors are **unaffected** — they only construct and
  hand the store to `DoSessionRepo`/`makeHubRegistry`; leave them alone.

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

- `KvStore` is effect-based; `grep -n "tryPromise" packages/hub/src/registry.ts
  packages/hub/src/skills.ts` returns nothing; `grep -n "runPromise"
  packages/store/src/kv.ts` returns nothing.
- `do-session.ts` still satisfies pi's conformance (`SessionBackendConformance` in
  `worker/test/do-session.test.ts`) — all tests green.
- `listFiles` no longer serializes entries.
- No file edited outside the owned list.
