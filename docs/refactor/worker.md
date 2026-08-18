# Refactor report: `packages/worker`

Scout: full read of every `src/` and `test/` file in the package, cross-checked
against Effect's own API surface (`~/Development/repos/effect/packages/effect/src`)
and the lutra reference (`~/Development/personal/apps/lutra/packages`).

## Overview

`@saku/worker` is the package that runs one thread's pi session: the local
daemon (`daemon.ts`) serves the wire protocol over WebSocket, owns the durable
thread registry (`registry.ts`) and the model catalog (`model-catalog.ts`), and
per thread builds a `SessionHost` (`session-host.ts`) — a pi-agent-core
`Agent` + `Session` driven through an effect-machine actor
(`session-machine.ts`) over a `KvStore`-backed trail (`do-session.ts`,
`do-session-repo.ts`, `session-state.ts`, `session-schemas.ts`). The
pi-sessions window (`pi-sessions/`) reads pi's own session files for adoption.

Size: ~6,400 source lines across 25 files + ~2,600 test lines. No file is near
1000 lines — the two biggest are `session-machine.ts` (715) and `daemon.ts`
(696) — but the package is the largest in the monorepo and carries the most
architectural tension.

**The one structural fact that explains almost everything:** pi's
`Agent`/`Session`/`SessionStorage`/`SessionRepo` are promise-based, and the
worker's durability seam (`KvStore`) is Effect-based with error channel `never`.
The code handles this by re-wrapping the pi seam at **every call site** with
`Effect.tryPromise({ catch: toSessionHostError, try: ... })` instead of
converting once at a boundary. That single decision produces ~35 repetitive
wrap sites, a promise ping-pong inside `DoSessionStorage`, and a host that
cannot distinguish "storage defect" from "command rejection".

The lutra reference shows the cleaner posture: effect services with
`Context.Service` + `Layer.effect`, tagged `Schema.TaggedErrorClass` failures on
the error channel, promise/effect crossings confined to a worker-message
boundary (`Deferred` + `postMessage`), and `Effect.runFork` used only to route
out-of-runtime events into the runtime — never as the primary error-handling
path.

## Critical Issues

1. **The pi promise seam is re-wrapped at ~35 sites instead of converted once.**
   `session-machine.ts` has 10 `Effect.tryPromise` sites (lines 194, 232, 261,
   286, 301, 322, 361, 386, 436, 614) — every one is the same shape:
   `Effect.tryPromise({ catch: toSessionHostError, try: async () => await deps.session.getLog() })`.
   `session-host.ts` has 15 more, `agent-events.ts` 2, `do-session-repo.ts` 3,
   `model-catalog-factory.ts` 2. The wrap is identical everywhere; only the pi
   call differs. **Fix: one Effect adapter over `Session`** (e.g.
   `TrailSession` exposing `getLog`/`appendEntry`/`appendMessage`/`getEntry`/
   `findOpenOperations`/`setName`/`moveLane`/`getLeafId`/`getStats`/`getName` as
   Effects), built once in `SessionHost.create`. Every `Effect.tryPromise` in
   the machine and host collapses into a plain `yield*`. This removes ~25
   sites, kills the `toSessionHostError` import graph in `session-machine.ts`,
   and makes the "storage defect" vs "command rejection" distinction real
   (below).

2. **`DoSessionStorage` is a promise ping-pong with a hand-rolled serializer.**
   Every mutation crosses the seam three times:
   `enqueue` (promise) → `Effect.runPromise(Effect.gen { DateTime.now; buildEntry; Effect.tryPromise(() => this.appendMutation(...)) })` →
   `appendMutation` → `Effect.runPromise(this.log.put(...))`.
   The sequence-number serializer is a `tail: Promise` chain (`enqueue`/
   `chainTail`, do-session.ts:120, 352–362) — the exact thing Effect's
   `Semaphore` or `SynchronizedRef` is for, and everything beneath it is
   already Effect. `DateTime.now` is also fetched inside the promise-wrapped
   gen, a pointless crossing. **Fix: keep the `SessionStorage` interface
   promise-based** (pi's conformance suite demands it), but implement each
   method as *one* `Effect.runPromise` around an Effect body that uses
   `Semaphore.withPermit` for serialization and `yield* this.log.put(...)`
   directly. The `tail` chain and the inner `tryPromise` disappear.

3. **`RegistryError` is a dead error channel in this package.** Every
   `ThreadRegistryApi`/`HostRegistryApi` method and `CommandError`/
   `SakuDaemonLayer` carries `RegistryError` (registry.ts:33–60, daemon.ts:98,
   687), but the worker's own registry **never constructs it** — the header
   admits "the layer no longer produces it". The only construction sites in the
   monorepo are `deploy/src/thread-do.ts` and `hub/test/in-process-worker.ts`.
   Inside the worker it is pure type-level plumbing of a never-occurring
   failure that leaks into `SessionHostError`-typed pipelines via
   `Effect.mapError(toSessionHostError)` noise. **Fix: type the worker's
   registry seam as `Effect<_, never>`** (storage defects already `die` on the
   `KvStore` seam) and keep `RegistryError` only where it is produced (the
   thread DO). If the shared API shape must stay, at least stop threading it
   through the daemon's `CommandError` union.

4. **Dead error vocabulary.** `DaemonErrorCodes` includes `pi_sessions_not_served`,
   `unknown_command`, and `projects` (daemon-error.ts:15, 18, 21) — none are
   constructed anywhere in the worker. `RegistryErrorOps` is `["list", "persist"]`
   but `op` is only ever set to `"persist"` (and only in thread-do). These
   literals are the "single source of truth" for codes that don't exist;
   every future match on them is a trap. **Fix: delete the unused members** or
   add an exhaustiveness test that constructs every declared code.

5. **Out-of-runtime events are forked with discarded errors.** `daemon.ts`
   routes socket events via `void Effect.runFork(...)` (onConnection,
   onError, onRecordChanged, sink) and the host's agent subscription is
   `agent.subscribe(async (event) => { await Effect.runPromise(handleAgentEvent(...)) })`
   (session-host.ts:314–316). A rejection inside `runPromise` becomes an
   unhandled promise rejection in pi's subscriber; a failing fork is silent.
   The lutra reference routes worker events through `Effect.runFork` too, but
   only to settle `Deferred`s — the failure path is explicit. **Fix: give
   every fork a terminal error handler** (`Effect.catchAllCause(Effect.logError)`
   before `runFork`), and make `handleAgentEvent` failures visible (the trail
   append is the durability point — a silent drop here loses a message).

## Structural Improvements (code judo)

1. **Extract the host cache + lifecycle out of `daemon.ts`.** 696 lines, and the
   command handlers (`runHubCommand`, ~300 lines of `Match.tagsExhaustive`) and
   the lazy host machinery (`hostFor`, `readOnlyHost`, `sessionStarted`,
   `broadcastState`) are two different concerns sharing one closure soup over
   `hostsRef`/`closedRef`/`serverRef`/`broadcastRef`/`hostSemaphore`. The
   session-command dispatch already lives in its own module
   (`session-commands.ts`) — the hub-command dispatch and the host-cache belong
   in siblings (`hub-commands.ts`, `host-cache.ts`). `broadcastState`'s
   `registry.setState → infoOf → emitThreadChanged → Effect.ignore` wrap is a
   subtle behavior (state pushes broadcast `thread_changed`) that a `HostCache`
   service would own and document once.

2. **`DoSessionRepo` should be Effect-native on the inside.** `create`, `import`,
   `open`, `list`, `fork` are all `async` methods whose body is
   `Effect.runPromise(Effect.gen(...))` — including `Effect.tryPromise` wraps
   around calls that are *already* promise methods of `DoSessionStorage`
   (`DoSessionStorage.create`, `self.open`). If `DoSessionStorage` becomes
   Effect-native internally (critical issue 2), the repo's `Effect.gen` bodies
   drop their `tryPromise` layers and keep a single `runPromise` at the
   `SessionRepo` interface edge. The `import` used by the daemon's
   `import_pi_session` handler is currently wrapped *again* in the handler
   (`Effect.tryPromise({ try: async () => await new DoSessionRepo(kv).import(...) })`,
   daemon.ts) — one seam, three crossings.

3. **Kill the `broadcastRef` indirection.** `emitSessionEvent`/`emitThreadChanged`
   do `Ref.get(broadcastRef) → broadcast(...)` because the handlers are built
   before `WireServer.make`. Since `WireServer.make` takes handlers as *values*
   (server-core.ts), the cycle is only in the author's head: build a `broadcast`
   function that reads a `Ref<Option<Fn>>` seeded `none` and *fail or no-op on
   none*, or build the core first with handlers that read refs (they already
   do). The current shape works but adds a no-op-fallback ref whose only
   invariant ("set before listen") is never checked.

4. **`model-catalog.ts` (450 lines) is really two modules.** The models.json
   layer — schemas (`ModelsJsonSchema` …), `modelFromJson`, `streamsFor`,
   `apiKeyAuthFor`, `applyModelOverrides`, `loadModelsJsonFrom`,
   `buildCustomProvider`, `overlayBuiltinProvider` — is ~300 lines of
   config-file parsing bolted onto the catalog service. Extract
   `models-json.ts` (parse/build) and leave `model-catalog.ts` with the
   service + layer wiring. The `SAKU_FAKE_MODEL`/auth plumbing already has a
   home (`model-catalog-factory.ts`).

5. **`pi-sessions/v4.ts`'s `jsonlFsOf` is 100 mechanical lines that repeat one
   shape**: `Effect.runPromise(fsOp.pipe(Effect.result))` → `ok`/`err(fail(...))`.
   A 10-line helper (`toJsonlResult(fsOp)`) collapses all twelve methods. This
   is the *right* boundary (pi's `JsonlSessionRepoFileSystem` is a promise
   interface) — it just shouldn't be written out twelve times.

6. **`session-commands.ts` docstring lies about `get_session_stats`.** The
   header says "the four read-only commands are served through `readOnlyHost`
   (browsing never starts a session)" — but there are five reads and
   `get_session_stats` uses `hostFor` (line 127–128), starting the session.
   Either stats genuinely need the trail (document it, call it out of the
   read-only set) or it should be served read-only like the others. As written,
   a console fetching stats on a never-started thread silently creates it —
   the exact violation ADR 0004's read-only posture exists to prevent.

7. **`isolate.ts` is one import away from breaking the DO bundle.** It
   re-exports `HostRegistryApi`/`ThreadRegistryApi` *types* from `registry.ts`,
   which transitively imports `paths.ts` → `node:os`/`node:path`. Type-only
   imports erase, so the graph stays workerd-clean today — but the moment
   someone re-exports a *value* from that module, `node:os` lands in the DO
   bundle. Move the two registry interfaces into a node-free module (or
   `registry-record.ts`'s neighbor) so the isolate boundary is structural, not
   incidental.

## Effect Migration (Promise → Effect)

| Site | Count | Migration |
|---|---|---|
| `session-host.ts` | 15 `tryPromise` | Replace with the `TrailSession` adapter (critical 1); `getState`'s `Effect.all` of five `tryPromise` becomes five plain yields. |
| `session-machine.ts` | 10 `tryPromise` | Same adapter; the machine then carries zero pi-seam knowledge beyond `Session`'s types. |
| `do-session.ts` | 6 `tryPromise`, 9 `runPromise` | Semaphore-serialized Effect body, one crossing at the interface (critical 2). |
| `do-session-repo.ts` | 7 `runPromise` | One crossing per `SessionRepo` method; drop inner `tryPromise` wraps. |
| `auth-json.ts` | 3 `runPromise`, 6 `async` | `CredentialStore` is promise-based, so the class stays async — but `persistBestEffort` is `tryPromise → result → logError`; Effect has `Effect.ignoreLogged` for exactly this. |
| `model-catalog-factory.ts` | 2 `tryPromise` | `hasAuth` chains `tryPromise → map → catchEager`; a single `Effect.tryPromise({ catch: () => false, ... })` says the same thing in half the code. |
| `pi-sessions/v4.ts` | 9 `runPromise` | Boundary-appropriate; factor the `ok`/`err` mapping helper (structural 5). |
| `agent-events.ts` | 2 `tryPromise` | Collapse via `TrailSession`. |

**The boundary principle to enforce:** promise crosses into Effect exactly
once, at the object that implements pi's promise interface (`SessionStorage`,
`SessionRepo`, `CredentialStore`, `JsonlSessionRepoFileSystem`). Every layer
above it (`Session` → `TrailSession` → machine/host) should be Effect-native.
`Effect.runPromise`/`runFork`/`runSync` in production code is a smell unless
the surrounding object is a promise-interface adapter — the worker currently
has `runPromise` calls in `session-host.ts`, `daemon.ts` (forks), and `auth-json.ts`
beyond the adapters.

## Type Safety Improvements

1. **`CompactResultOpaque = Schema.declare<CompactResult>((_u) => true)` is a
   lie** (session-machine.ts:57). A schema that validates nothing but claims
   `CompactResult` is `Schema.Unknown` wearing a costume — the `ReplyOk.result`
   field can hold any value and the type says it's a `CompactResult`. Either
   use `Schema.Unknown` and guard at the consumer (`session-host.ts` already
   branches on `reply.result === undefined`), or carry the value opaque but
   name the schema honestly. Right now the schema gives false confidence at
   the exact point (compaction results crossing the actor boundary) where
   validation matters.

2. **`buildEntry`/`buildRecord` double-assert** (`session-schemas.ts`):
   `decodeEntry({ ...provisioned as object, ... }) as unknown as TEntry`.
   The comment admits the input is `ProvisionedEntry<TEntry>` so the output is
   `TEntry` by construction — then the decode adds nothing the types don't
   already know, and the `as unknown as` erases the check it performs. If the
   schemas are the storage boundary's validation, they should decode the
   *final* shape into a named schema type and let the caller's generic align
   with it; the current shape validates then throws the proof away.

3. **`projectAgentEvent` has three `as SessionWireEvent` casts** with SAFETY
   comments (agent-events.ts:63–86). The `message_update` strip mutates the
   event's payload shape without a type-level witness. This is the wire's
   contract — make it a `Match` over the event union that returns
   `SessionWireEvent` per branch (the compiler then proves the strip), instead
   of casting. `stripUndefined`'s `Effect.die("message lost its shape...")`
   path is a latent defect that a schema-narrowed round-trip would make
   impossible.

4. **`isThinkingLevel`** (session-host.ts:32) casts `THINKING_LEVELS` to
   `readonly string[]` to call `includes` — fine, but a `Set` from the
   canonical array removes the cast entirely and reads better.

5. **`daemon.ts`'s `createOptions`** mutates a `const` object field-by-field
   (`createOptions.cwd = command.cwd`) to dodge optionality. Build with a
   spread:
   `{ name, ...(command.cwd !== undefined && { cwd: command.cwd }), ... }` —
   the same pattern `registry.ts` already uses for `source`. One less mutable
   local.

6. **`registry.ts`'s `indexLoaded` line `nameAuto: record.nameAuto`** is a
   no-op re-assignment — `ThreadRecordSchema` makes `nameAuto` required, so
   the comment's "records written before auto-title have no nameAuto" case
   cannot reach here (the record layer skips decode failures). Either the
   schema needs `optionalKey` (real legacy support, like `archivedAt`) or the
   line and comment go. Currently the comment promises behavior the schema
   contradicts.

## Minor Cleanups

- **Double blank lines** in `session-host-error.ts`, `registry-error.ts`,
  `daemon-error.ts`, `models-json-error.ts`, `do-session.ts`, `common.ts` —
  style noise that violates the repo's own style.md.
- **`fake-provider.ts`**: `stream` and `streamSimple` are the identical
  body; one shared `fakeStream` removes the duplication.
- **`entriesFromLog`** (session-machine.ts:87) returns *entries*, not log
  items — rename to `entriesOf` or similar.
- **`projects.ts`** builds a fresh `KvStore.file` layer per call
  (`Effect.provide(KvStore.file(fs, paths.sakuDir))` inside each function).
  Correct (layers are cheap closures) but a shared
  `withProjectsKv(fs, paths, body)` helper removes the triplication and makes
  the one-root invariant visible.
- **`auth.ts` `ensureAuthToken`** writes with `mode: 0o600` then calls
  `chmod` again — one of the two is redundant (keep the explicit `chmod`, drop
  the mode arg or vice versa).
- **`model-catalog.ts` env build** loops `Object.entries(process.env)` with a
  guard — `Object.fromEntries` + `Record.filter` does it in one expression.
- **The `taggedError` alias in tests** (`fake-error.ts`, `session-host.test.ts`,
  `remote-host.test.ts`) exists only to appease an oxlint heuristic about
  `new` on `Schema.TaggedError`. The lint rule is fighting a legitimate API;
  an oxlint config exception is the fix, not three copies of an alias.
- **`dispose`'s hardcoded `Effect.timeout(Duration.seconds(10))`**
  (session-host.ts:362): a stuck machine costs 10s per host on daemon close.
  Acceptable, but the constant deserves a name and a comment saying what a
  stuck host means for shutdown.
- **`cwdOf`'s `globalThis as { process?: ... }`** cast (registry.ts) is honest
  and contained — leave it, but note it's the only place the worker touches
  `process` outside `daemon-entry.ts`/`model-catalog.ts`.

## Priority order

1. `TrailSession` adapter (kills ~25 `tryPromise` sites; unblocks everything
   else in the machine/host).
2. `DoSessionStorage` internal Effect rewrite (semaphore serialization, one
   seam crossing).
3. Drop the dead `RegistryError` channel and unused error codes.
4. Split `daemon.ts` (hub-commands + host-cache) and `model-catalog.ts`
   (models-json).
5. Fix `get_session_stats`'s read-only violation and the fork-error silence.
6. Type-safety passes: `CompactResultOpaque`, `projectAgentEvent` casts,
   `buildEntry`/`buildRecord`.
7. Minor cleanups.
