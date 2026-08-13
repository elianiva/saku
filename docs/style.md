# House style — patterns, reasons, dos and don'ts

How saku code is written, distilled from the effect-idiom refactor pass. Every
pattern here exists in the current codebase because the version it replaced was
a real problem — the reason is the point, not the rule.

## The promise rule

Promises exist at exactly one seam: **pi-agent-core's interfaces**. pi's
`SessionRepo`/`SessionStorage`/`CredentialStore`/`ExecutionEnv` are promise-shaped —
that is pi's contract, keep it, and cross once per method (`Effect.runPromise`
inside the seam method). Everything saku-side is Effect. Other promise edges are
platform boundaries: the CLI entry, DO `fetch`/`alarm`.

**Why**: the old `KvStore` was promise-shaped but saku's own — consumers wrapped
every call in `Effect.tryPromise`, the file backend wrapped every call in
`Effect.runPromise`: two directions of boundary-crossing for one interface, and
`Effect.promise(() => …)` round trips on top of that.

**Do**: `yield*` Effect services everywhere; `runPromise` once at the seam or the
process edge; make a non-pi static constructor an Effect (`AuthJsonCredentialStore.load`
is an Effect, not `static async`).

**Don't**: write saku code in `async`/`Promise`; wrap saku's own async code in
`Effect.promise` — there is none; `Effect.tryPromise(() => Effect.runPromise(...))`
is always wrong.

## Schemas over casts

saku's own formats and persisted contracts are Schema-typed: models.json codecs,
`ThreadRecord`, `EnvHandle`, `HubPush`, `EnvConfig`, the console's projections.

**Why**: these are contracts — they cross RPC boundaries and DO storage, and
`JSON.parse(x) as T` casts rot silently into a `TypeError` at some random field
read instead of a decodable failure at the boundary.

**Do**: `Schema.Struct` for own formats; decode at boundaries with
`Schema.decodeUnknownOption/Sync` hoisted at module scope; `Effect.try`/
`Result.try` at sync parse points; `Schema.optionalKey` where a wire field may be
absent (pi's own optional fields — see `HubPushSchema` in `hub-do.ts`).

**Don't**: `JSON.parse(x) as T`, `as unknown as`, hand-rolled structural
narrowing; throw-driven validation with try/catch.

**pi's types stay opaque on the wire** (ADR 0005): never re-schema pi's types in
`@saku/wire`. The console's rendering vocabulary is its own local projection
(`frontend/src/projection.ts`), decoded only in the console.

## Tagged errors

```ts
export class XError extends Schema.TaggedError<XError>()("XError", {
  kind: Schema.Literals(["a", "b"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}
```

**Why**: catch-all `{message, cause}` errors are "tagged in name only" — every
failure site is a fresh string, so callers can only match on message text.
`WireError` (the house model) and opencode's `Git.OperationError` discriminate
with literals, so callers `catchTag`.

**Do**: a `kind` literal per failure class (model/auth/compaction/busy…); every
construction site passes one; `catchTag` at call sites; keep `message` + optional
`cause`.

**Don't**: fresh strings per failure site; a `catch: () => undefined` that swallows
a typed error (see the old `rpc.ts` idle-stop disarm); catch-all `Effect.catch`
where the failure set is known.

**Staging**: `kind` may be `optional` while construction sites outside your file
haven't migrated yet (`HubError`, `SessionHostError` still do this — the daemon's
`new SessionHostError({ message: ... })` at `worker/src/daemon.ts:336` is the last
straggler). Make it required when the last site migrates.

## Services

`Context.Service` class + static `Layer.Layer` factories — `KvStore`
(`store/src/kv.ts`: `memory()`/`file()`/`doStorage()`) is the pattern.

**Why**: `KvStore` used to be a constructor argument threaded through `makeHub*`
factories with every call wrapped in `Effect.tryPromise`. A service with layer
factories lets each composition site pick its backend at the boundary, and
consumers just `yield* KvStore`.

**Do**: consumers `yield* Service`; composition sites provide the layer at the
boundary; backends built lazily and fresh per build (`Layer.sync`) so two provides
never share state; the shape travels as a value type (`KvStoreShape`) into
promise-seam classes that can't `yield*`.

**Don't**: pass storage/host dependencies as constructor arguments through layers
of factories; module-level mutable singletons.

## Match over switch

`Match.value(x).pipe(Match.withReturnType<T>(), Match.tagsExhaustive({ … }))` for
dispatch on tagged unions.

**Why**: the hand-rolled `default: { const exhaustive: never = x }` is boilerplate,
and a silent default swallows new tags forever — the frontend's `foldWireEvent`
`switch` absorbed new pi event types into `[model, none]` invisibly, and the env
daemon's 20-case `runOp` switch carried the same tail.

**Do**: `tagsExhaustive`; when a union is open (pi grows events), name the long
tail explicitly — the frontend's `unhandled` tag is the honest version of a silent
default.

**Don't**: `switch` with a `default` arm for tagged unions; `const exhaustive:
never` hand-rolls; casting an event to its expected type before folding.

## Effect idioms

- **Polling/waits** — `Effect.retry` + `Schedule` (`spaced`/`exponential`/`upTo`).
  *Why*: the CLI had four `for (i < 100) { sleep; probe }` loops and `box.ts`
  polled by self-recursion against a `Date.now()` deadline — imperative timing that
  `Clock` can't fake in tests. *Don't*: `for` loops with sleeps, `Date.now()`
  deadlines, `pollUntilReady`-style recursion.
- **Independent iterations** — `Effect.forEach(..., { concurrency: "unbounded" })`.
  *Why*: `listThreads` and `listFiles` serialized independent reads in `for`
  loops. *Don't*: sequential loops over independent work.
- **Equality** — `Schema.equivalence(T)`. *Why*: `applyReport` compared states with
  `JSON.stringify(before) !== JSON.stringify(after)` — order-sensitive, wasteful,
  and wrong as an equivalence. *Don't*: stringify comparison.
- **Listener containment** — `Result.try(() => listener(event))` + warn. *Why*:
  the hub's `notify` used try/catch while the wire client's `emit` used
  `Result.try` — one concept, two implementations. *Don't*: try/catch around
  listeners.
- **Boundary settling** — `Effect.result` / `Effect.option` / `Effect.catchTag`.
  *Don't*: `catch: (error) => error as Error` casts without `instanceof`
  (passthrough: `cause instanceof Error ? cause : new Error(String(cause))`).
- **No try/catch inside Effect code** — `catchEager` for sync-effect recovery.

## Boundaries

- **Isolate-cleanliness**: anything exported through `@saku/worker/isolate` must
  not import node (`fake-provider.ts` is node-clean).
- **Plain `new Error(...)` only at process edges**: CLI usage errors (the exit
  path), startup defects — opencode-style "plain Error at process edges".
- **DO `fetch`/`alarm` entry points are promise-shaped** — the platform seam, like
  the CLI's `Effect.runPromise(main())`. `runPromise` once at that edge; memoize
  lazy construction as a named Effect run once (`buildHubShape` + a promise cache),
  not `await` + `Effect.runSync` mixed mid-function.
- Refactors add **no new dependencies**: `effect@4.0.0-beta.106` + workspace
  packages only.

## File shape

One concept per file; files stay ≤ ~1000 lines — split instead
(`session-host.ts` was 1149 lines and became four modules: host value, machine,
agent-event projection, error type; each is small and imports without cycles).

**Don't**: leave TODO/stub comments; leave shims or aliases behind — a refactor
migrates every caller.

## Reference repos (idiom ground truth — cite these in PRs)

- `~/Development/repos/opencode` — `packages/core/src/fs-util.ts` (`Effect.fn` +
  `Effect.try` → TaggedError), `packages/core/src/session/store.ts`
  (`Context.Service` + `Layer.effect`), `packages/core/src/git.ts` (errors with
  operation literals), its `AGENTS.md` (no try/catch, no `any`, bind services to
  named variables, early returns).
- `~/Development/personal/apps/lutra` — `frontend/src/editor/update.ts:218`
  (`Match.tagsExhaustive` + `withReturnType`), `editor/command.ts:98`
  (`Effect.tryPromise` → TaggedError), `editor/message.ts` (failure-set unions),
  `root/subscriptions.ts:14` (`Stream.fromPubSub`), `luts/store.ts:46` (passthrough
  catch), `offline/fill.ts:236` (`Effect.retry` + `Schedule.exponential`),
  `gpu/backend.ts:135` (`catchTag` → die for `Layer<never>`), `encode/worker-layer.ts:40`
  (`Effect.runFork` escape hatch), `errors.ts` (`TaggedErrorClass` shape).
- `~/Development/repos/foldkit` — `typing-game/client/src/update.ts` (submodel
  delegation, `Command.mapMessages`), `page/home/update/update.ts`
  (`M.tagsExhaustive`), `message.ts` (`m()` + `S.Union`), `command.ts`
  (`Command.define` + catch → Failed message), `subscription.ts`
  (`Subscription.make` + entry), `examples/websocket-chat/src/main.ts`
  (`Stream.callback` + `Queue.offerUnsafe` + `acquireRelease`),
  `examples/api-cache/src/main.ts` (`Effect.result` + `S.Result`).
