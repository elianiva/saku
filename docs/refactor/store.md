# `@saku/store` refactor report

Review of `packages/store` (448 lines of source: `index.ts` 13, `keys.ts` 51,
`kv.ts` 223, `platform-error.ts` 43, `records.ts` 118; plus `test/kv.test.ts`
80, `test/records.test.ts` 109). Ground truth for the assessment:
`docs/style.md` (the house idiom rules) and `~/Development/personal/apps/lutra/packages/store/`
(the reference implementation for Effect-shaped storage).

---

## Overview

The package is the durability seam: an Effect service `KvStore` (the Durable
Object storage contract) with three backend layers (`memory()`, `file()`,
`doStorage()`), a typed JSON record layer (`jsonRecords`) scoped to one key
prefix per consumer, branded key constructors, and the `isNotFound` platform
helper. It is consumed by the hub (registry, skills store) and the worker
(session trail, project list, credential stores).

**The good news first — this package is already ~90% idiom-correct.** It was
clearly the beneficiary of the effect-idiom refactor pass `style.md` documents:
the seam is a `Context.Service` with static layer factories; backends are
`Layer.sync` and fresh per build (tested); reads answer `Option`, never
`undefined`; the error channel is `never` ("defects kill the caller"); the only
promise crossing is `doStorage`'s `Effect.tryPromise` + `Effect.orDie` at the
platform boundary — exactly what `style.md` prescribes. None of that should be
touched.

The remaining problems are concentrated in **`records.ts`** (which violates
three explicit house rules) and in the **file backend's failure posture**
(which contradicts the seam's own documented contract). Both are fixable with
small, surgical changes that make the package dramatically simpler, not
bigger.

---

## Critical Issues

### 1. `jsonRecords` decodes without a schema — hand-rolled narrowing + throw-driven validation (violates `style.md` "Schemas over casts")

`records.ts` `isRecordObject` / `decodeRecord`:

```ts
const isRecordObject = <B>(value: B): value is A & B => {
  const isObject: A | boolean = typeof value === "object" && value !== null;
  return isObject;
};

const decodeRecord = (value: Uint8Array): A => {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(value));
  if (!isRecordObject(parsed)) {
    throw new Error("[store] corrupt record: expected a JSON object");
  }
  return parsed;
};
```

The *entire* shape contract for a typed record is "is an object". A stored
record missing required fields, with wrong field types, or with a wrong `kind`
literal decodes as a valid `A` and flows straight into consumers. Concretely:
`do-session.ts` replays `SessionMutation` values whose shape was never
validated — `mutation.kind`, `mutation.entry.seq` — so one corrupted-but-parseable
record throws a `TypeError` deep inside the replay path instead of failing at
the boundary. `style.md` bans exactly this: "Don't: `JSON.parse(x) as T`, …
hand-rolled structural narrowing; throw-driven validation with try/catch."
The reference (lutra `edit-store.ts` / `edit.ts`) types every persisted record
with a `Schema.Struct` and decodes at the boundary.

**Fix:** `jsonRecords` takes a schema, not a type parameter:

```ts
export const jsonRecords = <S extends Schema.Schema.Any>(
  kv: KvStoreApi,
  prefix: string,
  schema: S,
): RecordCollection<Schema.Schema.Type<S>> => { ... }
```

Decode with `Schema.decodeUnknownOption(schema)` — no `throw`, no `Effect.try`,
no narrowing. Migration cost is real but mechanical: the five `jsonRecords`
call sites (hub `registry.ts`, hub `skills.ts`, worker `registry.ts`,
`do-session.ts`, `do-session-repo.ts`) each pass their record schema. The
worker's `ThreadRecord` already has a schema; `HubRecord`/`SkillInfo`/
`SessionMutation` need `Schema.Struct` definitions (they are plain interfaces
today). This is a clean cutover — no shims.

### 2. Corrupt data silently reads as *absence* — the "missing" and "corrupt" cases are destroyed on `get`

`records.ts` `get`: missing **and** corrupt both answer `Option.none`, with
zero logging:

```ts
get: (key) =>
  kv.get(`${prefix}${key}`).pipe(
    Effect.flatMap((value) =>
      Option.match(value, {
        onNone: () => Effect.succeed(Option.none<A>()),
        onSome: (bytes) =>
          Effect.try(() => Option.some(decodeRecord(bytes))).pipe(
            Effect.catchEager(() => Effect.succeed(Option.none<A>())),
          ),
      }),
    ),
  ),
```

The test suite enshrines this (`records.test.ts`: "skips corrupt records on
list and reads them as none on get"). Consequences: a corrupted hub registry
record makes the thread *vanish* from the console with no warning; a corrupted
`meta` reads as "session not found" (`do-session.ts` load). The operator cannot
distinguish "deleted" from "broken", and nothing is logged. This contradicts
the house model (lutra: "A corrupt id inside a saved Edit is corruption, not a
recoverable case"; saku's own `auth-json.ts`/`model-catalog.ts` log loudly on
corrupt files).

**Fix:** with the Schema decode from issue 1, use
`Schema.decodeUnknownOption` **and log the failure**, at minimum:

```ts
Effect.flatMap((bytes) =>
  Schema.decodeUnknownOption(schema)(JSON.parse(new TextDecoder().decode(bytes)))
)
```

Decode failures then surface through `Effect.logWarning` (or a tagged `StoreError`
with `kind: "corrupt"` if callers need to distinguish) instead of vanishing.
`list` already logs — make `get` match it, and decide *as a policy* whether
corrupt records fail the load or are skipped (the ADR-level question the
"missing == corrupt" conflation currently answers silently).

### 3. Plain `Error` thrown inside Effect code (violates `style.md` "No plain `Error`")

`throw new Error("[store] corrupt record: expected a JSON object")` in
`decodeRecord` is the exact pattern `style.md` bans ("`new Error(...)` /
`throw new TypeError(...)` … are banned — even at process edges and in
tests"). It is currently caught immediately by `Effect.try`, which is why it
survived review — but it is still a plain `Error` construction in a package
whose own style document forbids it. The Schema fix (issue 1) deletes it.

### 4. The file backend's failure posture contradicts the seam's documented contract

`kv.ts` header: "The seam is effect-based with error channel `never`: storage
defects kill the caller." The file backend honors that on exactly **one** of
its four operations:

| op | file backend | posture |
|---|---|---|
| `get` | NotFound → `none`, else `Effect.die` | ✓ correct |
| `put` | `Effect.fn` + `Effect.orDie` | ✓ correct |
| `delete` | `fs.remove(...).pipe(Effect.catchEager(() => Effect.void))` | ✗ swallows **everything** — permission errors, disk errors read as success |
| `list` | `catchEager(() => succeed([]))` on `readDirectory`; `catchEager(() => succeed({value: encode("")}))` per file | ✗ a real I/O defect reads as "empty dir" / "empty file" → downstream "corrupt record" noise |

The `list` file read is the worst: an unreadable file becomes an *empty value*,
which `jsonRecords` then decodes as a corrupt record and skips — so a
permission failure masquerades as corruption and is quietly dropped. Meanwhile
`doStorage.delete` dies, and `memory().delete` cannot fail. Three backends,
three different meanings for the same operation.

**Fix:** `delete` should be NotFound-tolerant + die otherwise (mirror
`get`'s shape); `list`'s `readDirectory` catch should pass through
`isNotFound`-tagged failures to `Effect.die`; per-file read failures should
die, not become `""`. A single `via`/`dieOn` helper makes this uniform (see
Structural Improvement 1).

### 5. The seam is missing `clear()`/`deleteAll` — consumers work around it with platform promises

`DoStorageLike` has `deleteAll`; `KvStoreApi` does not. The two consumers that
need whole-namespace deletion both bypass the seam:

- `packages/deploy/src/thread-do.ts` `handleDelete`: `await this.state.storage.deleteAll()` — a raw platform promise inside an otherwise Effect-idiomatic DO.
- `packages/worker/src/do-session-repo.ts` `delete`: a `list` + per-key `delete` loop (O(n) round trips, and a torn state if it dies mid-loop).

**Fix:** add `clear: () => Effect.Effect<void>` to `KvStoreApi`
(memory: `map.clear()`; file: recursive `fs.remove(root)` — or `listFiles` +
per-key remove; doStorage: `Effect.tryPromise(() => storage.deleteAll())` +
`orDie`). Both workarounds become one seam call, and the platform-promise
escape hatch in `thread-do.ts` disappears.

---

## Structural Improvements

### 1. Collapse the four `tryPromise` + `orDie` repetitions in `doStorage` into one helper

```ts
const via = <A>(f: () => Promise<A>): Effect.Effect<A, never> =>
  Effect.tryPromise(f).pipe(Effect.orDie);
```

`doStorage`'s four identical shapes (`get`/`put`/`delete`/`list`) shrink to
~12 lines of pure promise adaptation, and the failure posture becomes uniform
by construction instead of by copy-paste. The same helper should back the
`clear()` addition from Critical Issue 5.

### 2. File backend `get`/`list`: use `fs.readFile` (bytes), not `readFileString` + `TextEncoder.encode`

`FileSystem.readFile` returns `Uint8Array` directly (effect
`src/FileSystem.ts`). The current `readFileString` → `TextEncoder.encode`
round trip is (a) a needless encode/decode and (b) **lossy for binary
payloads** — the seam's contract says "values are opaque byte strings"
("null/undefined are banned on this seam"), and `memory()`/`doStorage()`
handle arbitrary bytes, but the file backend silently mangles any non-UTF-8
value. `fs.readFile` fixes both and deletes the `encode` helper from `kv.ts`.

### 3. `records.list` — delete the skip-through-`undefined` dance

```ts
Effect.catchEager((failure) =>
  Effect.logWarning(`...`).pipe(Effect.as(undefined satisfies undefined)),
),
{ concurrency: 1 },
...
Effect.map((records) => records.filter((record) => record !== undefined)),
```

With Schema decode (issue 1) this becomes: decode each entry with
`Schema.decodeUnknownOption`, log on `none`, `Array.getSomes` the results.
Also: `{ concurrency: 1 }` is wrong per house style — "Independent iterations —
`Effect.forEach(..., { concurrency: "unbounded" })`". These are independent
reads; the file backend is serial today, but memory/DO benefit. If ordering
must be preserved, note the current code relies on `forEach`'s order-preserving
shape — `getSomes` after an unordered map preserves nothing, so sort by key
explicitly (as `do-session.ts` already does) instead of relying on traversal
order.

### 4. `listFiles` — pass the prefix filter into the walk and stop swallowing

`listFiles(fs, root, "")` walks the *entire* tree then filters by prefix; the
`prefix` parameter exists precisely so the walk can prune. Pass the caller's
prefix through and skip subtrees that can't match. And the
`Effect.catchEager(() => Effect.succeed([]))` on `readDirectory` swallows
permission errors as "empty dir" — only `isNotFound` failures should read as
empty (a missing dir on `list` is legitimate; the root dir's absence after a
fresh install is the common case); everything else dies.

### 5. `keys.ts` constructors claim validation they don't do

Header: "the constructor functions validate and format in one step." They
format; they do **not** validate. `SessionPrefix.create("")`, `.create("../x")`,
`LogKey.create(-1)`, `LogKey.create(1.5)` all produce garbage keys. The brand
gives compile-time safety but no boundary check; real validation lives
scattered (e.g. `validateSessionId` in `do-session.ts`). Reference: lutra's
`EditIdSchema` — `Schema.fromBrand` + `Schema.refine` with a format regex, so
a malformed id "fails the whole decode" at the boundary. At minimum correct the
docstring; the proper fix is schema-backed brands used at the decode boundary
(`LogKey`'s zero-padding is itself a format contract worth a refine). Note
`WorkerRecordKey.create(id)` with an id containing `/` breaks the key shape
for `thread.json` — worth a guard since ids are `crypto.randomUUID().replaceAll("-", "")` today.

### 6. `Effect.fn("put")` — generic name, lone user

Inside `KvStore.file`'s `Layer.sync` closure, `put` alone is wrapped in
`Effect.fn("put")` while `get`/`delete`/`list` are plain closures. Either
qualify it (`"KvStore.file.put"`, matching the house's `"HubRegistry.make"` /
`"SkillsStore.make"` naming) or drop the wrapper for uniformity — the `via`/
`dieOn` helper (Improvement 1) already gives `put` its `orDie` without needing
the transform-argument form. The tracing value of a generic `"put"` name is
near zero.

### 7. `kv.ts` is at 223 lines — split is optional, not required

Three backends × four operations in one file is approaching the matrix the
house file-shape rule warns about, but it stays well under the 1000-line cap
and the backends share `listFiles`/`dirname`/`keyPath` helpers. The bigger win
is shrinking the file (Improvements 1–4 cut a third of it). If it ever grows a
fourth backend (e.g. `KvStore.redis()`), split per-backend files like lutra's
`edit-store-indexeddb.ts`. Not now.

---

## Effect Migration

**Honest headline: there are no internal Promise APIs left to convert.** The
package is already fully Effect-shaped — `KvStoreApi` and `RecordCollection`
are all-Effect, no `Effect.promise` anywhere (banned by `style.md`), and the
only promise crossing is `doStorage`, which is the *correct* platform-boundary
pattern. The real remaining migration work is Effect-idiom, not promise→effect:

1. **records.ts: throw/`Effect.try` decode → `Schema.decodeUnknownOption`**
   (Critical Issue 1/3). This is the one place the package still hand-rolls
   what Effect gives for free — it is also the one place that violates the
   most house rules at once.
2. **`doStorage`'s `tryPromise`+`orDie`** is right but repetitive — the `via`
   helper (Improvement 1) is a mechanical consolidation, not a redesign.
3. **Consumer-side seam crossing worth flagging** (owned by `@saku/worker`, but
   caused by seam gaps): `do-session-repo.ts` wraps *its own* Effect code in
   `Effect.tryPromise` (`create`/`import`/`fork` call `DoSessionStorage.create`
   / `.open` via `tryPromise`, and `DoSessionStorage.create` is `static async`)
   because the pi `SessionRepo` interface is promise-shaped. That is legitimate
   pi-seam wrapping — but the `delete` O(n) loop is not pi's contract and should
   use the `clear()` from Critical Issue 5.
4. **`DoStorageLike` stays a promise interface.** It is the platform boundary;
   converting it to Effect would merely move the `tryPromise` one level down.
   Do not "migrate" it.

---

## Type Safety Improvements

1. **Schema-typed records** (Critical Issue 1) — the single largest type-safety
   win: `RecordCollection<Schema.Type<S>>` instead of `RecordCollection<A>`
   where `A` was trusted after an "is an object" check. The worker's
   `ThreadRecord` already has a schema and can be reused directly; `HubRecord`,
   `SkillInfo`, `SessionMutation` need `Schema.Struct` definitions.
2. **`isNotFound` duck-types Effect's error taxonomy.** `platform-error.ts`
   checks three structural shapes (`_tag === "NotFound"`, PlatformError+reason,
   ENOENT cause). It works, but it tracks Effect's `PlatformError`/`SystemError`
   shape by hand (`SystemErrorTag` includes `"NotFound"` in the installed
   `effect@4.0.0-rc.108`); if Effect renames a tag, the check silently rots
   with no compile error. Tighten the input type to
   `PlatformError | NodeJS.ErrnoException` (plus the bare-tag case) instead of
   `PlatformErrorLike`, and use `error.reason._tag === "NotFound"` against the
   typed `SystemError`. Modest, but it converts a duck-typed helper into one
   that fails to compile when Effect's taxonomy changes.
3. **Schema-backed brands** (Improvement 5): `SessionPrefix`/`LogKey`/
   `HubRecordKey`/`WorkerRecordKey` get format validation at the boundary,
   mirroring lutra's `EditIdSchema`.
4. **`memory()`/`list()` byte copies** (`new Uint8Array(value)`) are correct —
   defensive copies against aliasing; keep them.
5. **`DoStorageLike.get`** hard-codes `Uint8Array | undefined` — fine for this
   seam's use; do not widen to `unknown` (the `instanceof Uint8Array` filter in
   `list` would then be doing real work, and CF's `get<T>` typing would be
   lost).

---

## Minor Cleanups

- **`encode`/`decode` helpers are duplicated** across `kv.ts`, `records.ts`,
  `kv.test.ts`, `records.test.ts` (four copies of the same two-liner). After
  the `fs.readFile` fix, `kv.ts` and `records.ts` need neither; the test files
  can share a small helper.
- **`kv.test.ts` has no `doStorage` test.** The other two backends are covered;
  a fake `DoStorageLike` (a `Map`-backed object) would cover the promise seam
  and the `clear()` addition in one test. Cheap and it pins the
  platform-boundary behavior.
- **`records.test.ts` corrupt-record tests need revisiting** with the Schema
  change: "reads them as none on get" becomes "logs and reads as none" (or
  fails, per the policy decision in Critical Issue 2). Keep the list-skip
  assertion.
- **Add a binary round-trip test for the file backend** (a `Uint8Array` with
  non-UTF-8 bytes, e.g. `[0xff, 0x00, 0xfe]`) — today it fails silently via
  the `readFileString` mangling (Critical Issue / Improvement 2); after the fix
  it passes. This is the regression guard for the lossy round trip.
- **`kv.ts` header doc** says "no promise crosses this file" — true of the
  seam, but `doStorage` crosses promises at the platform boundary by design;
  the header already qualifies this, just don't let a future cleanup "fix" it.
- **`keys.ts` docstring** overstates validation (Improvement 5) — correct the
  claim when the constructors gain real checks.
- **`index.ts`** re-exports are fine; `isNotFound` is small enough to keep in
  its own module or fold into `kv.ts` — either way, no churn needed.

---

## Suggested execution order

1. **Schema-typed `jsonRecords`** (Critical 1, 3; Type Safety 1) — biggest win,
   touches all five consumers; land with the consumer schema definitions and
   updated `records.test.ts`.
2. **File backend posture + `fs.readFile` + `via` helper** (Critical 4;
   Improvements 1, 2) — all within `kv.ts`, one commit, with the binary
   round-trip test.
3. **`clear()` on the seam** (Critical 5) — then migrate `do-session-repo.delete`
   and `thread-do.handleDelete`; delete the `deleteAll` escape hatch.
4. **`listFiles` pruning + `records.list` concurrency/skip cleanup** (Improvements 3, 4).
5. **Brands, `isNotFound` typing, `Effect.fn` name** (Improvements 5, 6; Type
   Safety 2, 3) — mechanical, do last.

Do not touch: `Layer.sync` fresh-per-build isolation, the `Option`-answering
seam shape, `doStorage`'s promise crossing, or the memory backend's defensive
byte copies — all are correct and tested.
