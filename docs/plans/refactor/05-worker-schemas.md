# Plan — 05 · Worker schemas: models.json codec, record decoding, fake-provider dedupe

Status: **planned** — parallel plan 05 of the refactor pass (see `README.md`).

## Owned files

- `packages/worker/src/model-catalog.ts`
- `packages/worker/src/registry.ts` + `packages/worker/src/registry-error.ts`
- `packages/worker/src/fake-provider.ts` (new)
- `packages/worker/package.json` (new `"./fake-provider"` export)
- `packages/deploy/src/catalog.ts`

## Problem

1. **Round trip** (review P1-4): `AuthJsonCredentialStore.load` is `static async` with
   `Effect.runPromise` inside; the layer wraps it back with `Effect.promise(() =>
   load(...))` (`model-catalog.ts:60-95` and `:397`). `load` is not part of pi's
   `CredentialStore` interface — it should be an Effect.
2. **models.json parsing is manual + throw-driven** (review P4-13): plain TS
   interfaces + `JSON.parse(raw) as unknown` + structural narrowing
   (`loadModelsJsonFrom`, ~line 430), and the builders (`modelFromJson`,
   `streamsFor`, `buildCustomProvider`, `overlayBuiltinProvider`) **throw** for
   validation, caught by a try/catch inside the layer (~line 410).
3. **Cast-based record decoding** (review P4-11): `worker/registry.ts`
   `loadRecords` does `JSON.parse(content) as ThreadRecord` (~line 80).
4. **`RegistryError` is a catch-all** (review P2-5, staged like `HubError`).
5. **Fake provider duplicated** (review P6-18): `model-catalog.ts` (~lines 250-360)
   and `deploy/src/catalog.ts` both define `FAKE_PROVIDER`/`FAKE_MODEL`/fake streams.

## Design

### 1. `AuthJsonCredentialStore.load` as Effect

Keep the class implementing pi's `CredentialStore` (its `read/list/modify/delete`
stay async — that IS the pi seam). Change only the static constructor:

```ts
static load(path: string, fs: FileSystem.FileSystem): Effect.Effect<AuthJsonCredentialStore, never> =>
  Effect.gen(function* () {
    const content = yield* fs.readFileString(path).pipe(
      Effect.map(Result.succeed),
      Effect.catch((error) =>
        isNotFound(error) ? Effect.succeed(Result.fail(error)) : Effect.fail(error),
      ),
    );
    …
  });
```

Semantics to preserve: missing auth.json → empty store; unreadable auth.json →
`console.error` + empty store; unparsable/non-object JSON → `console.error` + empty
store. `Result.try(() => JSON.parse(...))` is fine here (auth.json is pi's format,
not ours to re-schema — ADR 0005 spirit; only validate it is a record). The layer
becomes `const credentials = yield* AuthJsonCredentialStore.load(...)`.

### 2. models.json Schema codec

Define in `model-catalog.ts` (these ARE saku's formats — schema them):

```ts
const ModelsJsonModel = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  api: Schema.optional(Schema.String),
  baseUrl: Schema.optional(Schema.String),
  reasoning: Schema.optional(Schema.Boolean),
  contextWindow: Schema.optional(Schema.Number),
  maxTokens: Schema.optional(Schema.Number),
  input: Schema.optional(Schema.Array(Schema.Literals(["text", "image"]))),
  cost: Schema.optional(Schema.Struct({
    input: Schema.optional(Schema.Number),
    output: Schema.optional(Schema.Number),
    cacheRead: Schema.optional(Schema.Number),
    cacheWrite: Schema.optional(Schema.Number),
  })),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  samplingParams: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

const ModelsJsonProviderConfig = Schema.Struct({
  name: Schema.optional(Schema.String),
  baseUrl: Schema.optional(Schema.String),
  apiKey: Schema.optional(Schema.String),
  api: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  models: Schema.optional(Schema.Array(ModelsJsonModel)),
  modelOverrides: Schema.optional(
    Schema.Record(Schema.String, Schema.partial(ModelsJsonModel)),
  ),
});

const ModelsJsonSchema = Schema.Struct({ providers: Schema.Record(Schema.String, ModelsJsonProviderConfig) });
```

`loadModelsJsonFrom` → `yield* Schema.decodeUnknownOption(ModelsJsonSchema)(raw)`-ish:
read file (missing → `{providers: {}}`), `Schema.decodeUnknownSync(ModelsJsonSchema)`
in a `Result.try`; failure → `Effect.logWarning` + `{providers: {}}` (same fallback
as today).

### 3. Make the builders total

New error type in the same file:

```ts
export class ModelsJsonError extends Schema.TaggedError<ModelsJsonError>()("ModelsJsonError", {
  message: Schema.String,
}) {}
```

- `modelFromJson` → `Effect.Effect<Model<Api>, ModelsJsonError>` (fails on missing
  `api`/`baseUrl` instead of throwing).
- `streamsFor` → `Effect.Effect<Partial<Record<Api, ProviderStreams>>, ModelsJsonError>`
  (fails on unknown api implementation).
- `buildCustomProvider` / `overlayBuiltinProvider` → compose the above with
  `Effect.gen`, error channel `ModelsJsonError`.
- The layer's per-provider `try { … } catch (error) { logWarning }` (~line 410)
  becomes `.pipe(Effect.catch((error) => Effect.logWarning(...)))` — the try/catch
  disappears entirely. Keep the exact log text.

### 4. `worker/registry.ts` record schema

```ts
const ThreadRecordSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  cwd: Schema.String,
  mode: ThreadMode,                 // imported from @saku/wire
  createdAt: Schema.Number,
  sessionId: Schema.Union([Schema.Null, Schema.String]),
  nameAuto: Schema.Boolean,
});
export type ThreadRecord = Schema.Schema.Type<typeof ThreadRecordSchema>;
```

(Keep the existing `interface ThreadRecord` doc comment; `ThreadRegistryShape` stays
as-is so `fakes.ts`/plan-02 files compile untouched.) `loadRecords`: replace
`JSON.parse(content) as ThreadRecord` with `Schema.decodeUnknownSync(ThreadRecordSchema)`
inside `Effect.try`; corrupt records → `catchEager(() => Effect.succeed(undefined))`
(same skip semantics). The `nameAuto: record.nameAuto === true` backfill in
`indexLoaded` stays.

### 5. `RegistryError` staged discriminant

Add `op: Schema.optional(Schema.Literals(["list", "persist"]))` (the two operations
the local registry performs). Migrate the two `toRegistryError("failed to …")` sites
in `registry.ts`. Optional on purpose: `deploy/src/thread-do.ts` (plan 02's file)
constructs `new RegistryError({message})` and must keep compiling.

### 6. Fake provider dedupe

- Create `packages/worker/src/fake-provider.ts`: move `FAKE_PROVIDER`, `FAKE_MODEL`,
  `fakeText`, `fakeToolCall`, `fakeApiKeyAuth`, `fakeProvider` from
  `model-catalog.ts` (the richer version with the tool-call/text alternation).
- Add to `packages/worker/package.json` exports:
  `"./fake-provider": { "types": "./src/fake-provider.ts", "import": "./src/fake-provider.ts" }`.
- `model-catalog.ts` imports it from the new module (behavior unchanged).
- `packages/deploy/src/catalog.ts`: delete its local `FAKE_PROVIDER`/`FAKE_MODEL`/
  `fakeMessage`/`fakeApiKeyAuth`/`fakeProvider` (~60 lines) and import
  `fakeProvider` from `@saku/worker/fake-provider`. **Check `deploy/test/deploy.test.ts`
  first**: it may rely on the deploy variant's text-only first answer vs. the
  worker variant's tool-call-first alternation. The worker variant is the correct
  one to keep (it exercises the full tool loop); if a deploy test asserts specific
  fake output, update that assertion in the test file — deploy tests are owned by
  plan 02, so if you must change the test, coordinate: prefer keeping both variants'
  *streams* identical by making `fakeProvider` accept the same alternation behavior
  and only touch `deploy/catalog.ts`. If the test breaks, note it in the plan status
  instead of editing it.

## Steps

1. `model-catalog.ts`: load-as-Effect, Schema codecs, total builders,
   `ModelsJsonError`, fake-provider import swap.
2. `fake-provider.ts` (new) + `worker/package.json` export.
3. `registry.ts` + `registry-error.ts`: record schema + staged `op`.
4. `deploy/catalog.ts`: import the shared fake provider, delete the local copy.
5. `pnpm --filter @saku/worker test` (session-host tests exercise the catalog via
   `fakeCatalog` in `fakes.ts` — leave `fakes.ts` alone; it implements
   `ModelCatalogShape` structurally and stays valid).

## References

- Schema-first config decoding: opencode `AGENTS.md` ("Prefer Schema helpers such as
  `Schema.UnknownFromJsonString` / `Schema.decodeUnknownOption` over manual
  `JSON.parse`") and `packages/core/src/session/store.ts:32`
  (`Schema.decodeUnknownEffect` hoisted once per module).
- `Effect.try`/`Result.try` at sync parse boundaries: opencode
  `packages/core/src/fs-util.ts:104` (`Effect.fn("FileSystem.readJson")` →
  `Effect.try` → tagged error).
- Static-constructor-as-Effect: opencode `packages/core/src/session/store.ts`
  (`Layer.effect` with `Effect.gen` doing setup) — the class/static pattern here is
  the same seam, just kept as a class because pi's `CredentialStore` requires it.
- Error kinds: `packages/wire/src/client.ts:80` `WireError`.
- Isolate-cleanliness: `packages/worker/src/isolate.ts` header — anything exported
  through isolate must not import node. `fake-provider.ts` is node-clean (verify:
  no `node:` imports).

## Verification

```sh
pnpm --filter @saku/worker typecheck && pnpm --filter @saku/worker test
pnpm --filter @saku/deploy typecheck && pnpm --filter @saku/deploy test
```

## Definition of done

- `grep -n "Effect.promise" packages/worker/src/model-catalog.ts` → nothing.
- `grep -n "try {" packages/worker/src/model-catalog.ts` → nothing (the layer
  try/catch is gone).
- models.json is schema-decoded; builders return Effects; `ModelsJsonError` exported.
- `ThreadRecord` is schema-decoded on load; no `as ThreadRecord` cast remains.
- Exactly one fake-provider definition; deploy imports it.
- Worker + deploy suites green; no files outside the owned list edited.
