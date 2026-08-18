# `@saku/env` refactor report

Review of `packages/env` (2582 lines of source: `protocol.ts` 266, `local-env.ts` 514,
`daemon.ts` 524, `remote.ts` 642, `socket.ts` 268, `relay.ts` 143, `entry.ts` 102,
`paths.ts` 26, `env-connection-error.ts` 29, `index.ts` 68; plus `test/env-daemon.test.ts`
~290). Ground truth for the assessment: `docs/style.md` (the house idiom rules),
the `Context.Service`/`Effect.fn`/`Schema.TaggedError` conventions already live in
`packages/hub` and `packages/worker`, `~/Development/personal/apps/lutra/packages/`
(the reference Effect usage), and the installed `effect@4.0.0-rc.108` /
`@effect/platform-node` API surface (verified against `.d.ts` in node_modules).

---

## Overview

The package is ADR 0003's "hands": the env daemon binary and its client. One
JSONL-over-WebSocket protocol (`protocol.ts`, fully Schema-typed — the ops are
pi's `ExecutionEnv` surface verbatim), a local engine `LocalEnv` (pi's promise
contract over the effect `FileSystem` service), a daemon server
(`daemon.ts`), a wire client `RemoteEnv` (`remote.ts`, with workerd/node
socket adapters in `socket.ts`), and the hub relay client (`relay.ts`).

**The good news: the package is already most of the way to idiom-correct.** It
was clearly touched by the effect-idiom refactor pass `style.md` documents:
`EnvDaemon`/`EnvRelayClient` are `Context.Service` with `Effect.fn` `make`
constructors; `EnvConnectionError` is a `Schema.TaggedError` with a `kind`
literal; the entire protocol is Schema-typed with a shared `EnvPayloadSchema`
table (encode on the daemon, decode on the client — no casts of the wire's own
formats); `runOp` dispatches with `Match.tagsExhaustive`; `entry.ts` is a
scoped resource under `Effect.never`. The two `ExecutionEnv` implementations
(`LocalEnv`, `RemoteEnv`) are *necessarily* promise-shaped — that is pi's
contract, and `style.md` says keep it and cross once per method.

The problems are concentrated in **saku's own code wearing a promise costume**:
`RemoteEnv`'s entire internal machinery (`connect`, `request`, `op`, `fileOp`)
is saku-owned async/promise code whose consumers then wrap it in
`Effect.tryPromise` — the exact double-crossing `style.md` bans. `local-env.ts`
has saku-owned async code *inside* an Effect-idiomatic file (`describeEntry`,
`listDir`'s `Promise.all`, and the literal `Effect.tryPromise(() => Effect.runPromise(...))`
round trip in `fileInfo`). And `daemon.ts` carries two chunks of hand-rolled
infrastructure the rest of the codebase already extracted into shared helpers:
`listenWs`/`wsUrlOf` (used by the worker daemon, hub server, and hub relay —
the env daemon did not migrate) and the package's own `SocketLike` surface
(`handleEnvConnection` is typed against node's raw `ws.WebSocket` and can never
run on workerd despite the header's "one handler, two transports" claim).

No file approaches 1000 lines (max: `remote.ts` at 642), so no splits are
required — the wins here are deletion, not decomposition.

---

## Critical Issues

### 1. `RemoteEnv`'s saku-owned machinery is promise-shaped — and every consumer pays for it with `Effect.tryPromise` round trips (violates the house promise rule)

`remote.ts` `connect()` (208–265), `request()` (376–418), `op()` (421–446),
`fileOp()` (449–457) are `async`/`Promise` — but none of them is part of pi's
`ExecutionEnv` contract. `style.md` is explicit: "Promises exist at exactly one
seam: **pi-agent-core's interfaces**" and "make a non-pi static constructor an
Effect". The consequence is visible at every call site:

- `deploy/thread-do.ts:351` — `yield* Effect.tryPromise(async () => await env.connect())`
- `cli/src/env.ts:114` — `yield* Effect.tryPromise(async () => await env.connect())`
- `hub/src/providers/box.ts:285` — `Effect.tryPromise` around `connect()`
- `deploy/test/deploy.test.ts:301` — same

Each is a promise created in saku's own code, wrapped in `tryPromise`, then
`runPromise`'d again at the DO/fetch seam — `style.md`'s "two directions of
boundary-crossing for one interface" verbatim. It also *loses* the typed error:
`connect(): Promise<EnvHelloOk>` rejects with an `EnvConnectionError`, but the
promise type says nothing about it, so consumers match message text
(`env-daemon.test.ts:85` `rejects.toThrow("invalid token")`,
`relay.test.ts:151` `rejects.toThrow("invalid relay token")`) — the exact
failure mode `style.md`'s tagged-errors section exists to kill.

**Fix:** make `connect` an Effect and the private machinery Effect internally:
- `connect(): Effect<EnvHelloOk, EnvConnectionError>` — replace the
  hand-rolled `{ done, finish, onClose, onMessage, onRawMessage }` state object
  and `onceHello` promise with a `Deferred<EnvHelloOk, EnvConnectionError>`
  plus `Effect.timeoutFail` (or `Effect.timer`) for the 15s hello deadline.
- `request()` returns `Effect<RequestOutcome>` over a `Map<string, Deferred<RequestOutcome>>`
  keyed by id — the pending-map shape stays, the plumbing becomes Effect.
  Timeout + `env_abort`-send becomes `Effect.timeoutFail` with the abort-send
  in a finalizer; the `AbortController` listener becomes `Effect.addFinalizer`
  on the request's scope.
- Only the `ExecutionEnv` interface methods keep the promise shape, crossing
  once with `Effect.runPromise` at the method boundary (per `style.md`).
- Migrate the four consumers: `thread-do.ts:351` becomes `yield* env.connect()`;
  `cli/src/env.ts` probe becomes `Effect.option(env.connect())` with the socket
  close in a finalizer; `box.ts` `probeDaemon` becomes
  `env.connect().pipe(Effect.result, ...)`. Tests assert `EnvConnectionError.kind`
  instead of message text.

A concrete correctness win falls out: today `box.ts` `probeDaemon` and
`cli/src/env.ts` probe only call `env.close()` on the *success* path — a failed
connect leaks the socket. An `Effect.acquireRelease`/finalizer shape fixes both.

### 2. `local-env.ts` contains saku-owned async code, including the banned `tryPromise(() => runPromise(...))` round trip

`describeEntry` (127–158) is a module-level `async` function — saku's own code,
not a pi-seam method. It is then wrapped at its two call sites:

- `fileInfo` (279–285): `Effect.tryPromise(async () => await describeEntry(...)).pipe(Effect.orDie, Effect.result)` — this is `style.md`'s "`Effect.tryPromise(() => Effect.runPromise(...))` is always wrong", verbatim: a saku promise created, awaited inside a promise, wrapped in `tryPromise`, and only then `result`-captured. The `orDie` makes it a defect on the *one* path (`describeEntry`'s own `runPromise`) that can genuinely reject.
- `listDir` (301–308): `await Promise.all(outcome.success.map(async (name) => await describeEntry(...)))` — a sequential-await loop over independent reads, which `style.md`'s "Independent iterations — `Effect.forEach(..., { concurrency: "unbounded" })`" bans.

**Fix:** make `describeEntry` a plain Effect (`Effect<FileInfo, never>` — its
stat/readLink failures are already `Effect.result`-captured inside). `fileInfo`
becomes `Effect.runPromise(describeEntry(fs, path).pipe(Effect.result))` and
`listDir` becomes `Effect.runPromise(Effect.forEach(entries, (name) => describeEntry(fs, join(dir, name)), { concurrency: "unbounded" }).pipe(Effect.result))`.
~30 lines of promise plumbing and the `orDie` hole disappear; the promise
boundary is crossed exactly once per public seam method, which is the rule.

### 3. `handleEnvConnection` is bound to node's raw `ws.WebSocket` — the package's own `SocketLike` exists precisely to prevent this

`socket.ts` was built to be "ONE transport-agnostic WebSocket shape for every
connection the spine drives" (module header), and the daemon header claims "the
same connection handler serves two transports … only the transport differs".
But `handleEnvConnection` (daemon.ts 307) takes `WebSocket` from `ws` directly,
and both node transports (`EnvDaemon.make`'s server, `runRegistration`'s
outbound socket in relay.ts) hand it raw `ws` sockets. The `SocketLike` surface
is used by `RemoteEnv`, the hub's `relay-core`, and the hub's `socket.ts` re-export —
but not by the daemon's own handler. A workerd-hosted daemon could not reuse
it; the "one handler" claim is type-untrue.

The port is nearly free: `handleEnvConnection` already uses only the
`SocketLike` methods (`send`/`close`/`on`/`once`/`off`) and its message handler
already normalizes with `isSocketMessage` + `decodeFrame`. The only delta is
that `onRawMessage: (data: RawData)` becomes `(data: SocketMessage)` — the
`nodeSocket` adapter already delivers Buffers as `SocketMessage`.

**Fix:** retype `handleEnvConnection(socket: SocketLike, ctx)`; add a small
server-side adapter `nodeSocketFromWebSocket(ws: WsWebSocket): SocketLike`
(socket.ts only has the client factory `nodeSocket(url)` today — the same
registry, fed from an existing socket's events); feed it from
`EnvDaemon.make`'s `connection` event and from `runRegistration`. The `RawData`
import disappears from daemon.ts, and relay.ts stops constructing raw
`WebSocket`s at all (it can use `nodeSocket(url)` via `acquireRelease`).

### 4. `EnvDaemon.make` duplicates `listenWs`/`wsUrlOf` from `@saku/wire/server`

`ws-server.ts` was extracted precisely to end the three-way duplication of the
"`Effect.callback<WebSocketServer, E>` + error/listening handlers + close-on-
interrupt finalizer + `server.address()` URL derivation" discipline — its
header names "the hub's wire server, **the env relay**, and **the local
daemon**" as its users. But the env daemon never migrated: `EnvDaemon.make`
(daemon.ts 493–515) still hand-rolls the same `Effect.callback<WebSocketServer, Error>`
block, including its own `isAddressObject` (61–63) and `ws://` URL derivation
(504) — while the worker daemon (`worker/src/daemon.ts:617`), the hub server
(`hub/src/server.ts:110`), and the hub relay (`hub/src/relay.ts:20`) all use
`listenWs` + `wsUrlOf`.

**Fix:** `EnvDaemon.make` becomes `yield* listenWs({ onConnection, onError })` +
`wsUrlOf(server)`, with the tagged startup-error mapping (currently the raw
`Error` failure channel — `listenWs`'s `onError` mapper is the house way to
tag it). One caveat: the env daemon supports a `host` option while `wsUrlOf`
hardcodes `127.0.0.1` — extend `wsUrlOf` with an optional host parameter (a
one-line change in `@saku/wire/server`, then delete `isAddressObject` from
daemon.ts).

### 5. `LocalEnv.exec` hand-rolls a ~130-line spawn state machine that `effect` now provides

`local-env.ts` exec (390–464): `node:child_process` `spawn`, manual stdout/
stderr accumulation, a `setTimeout` timer, an abort-listener registration,
`killTree` with the Windows `taskkill` branch, "settle once" discipline in
`fail`/`resolveResult`, and a `close`-event switch — all inside
`Effect.callback`. This is exactly the bookkeeping the installed
`effect@4.0.0-rc.108`'s `effect/unstable/process/ChildProcess` +
`ChildProcessSpawner` (with `@effect/platform-node`'s `NodeChildProcessSpawner.layer`)
exists to absorb: `make` with `detached`, `setCwd`, `setEnv`, `killSignal`,
`forceKillAfter`, and `timeout`; `StdoutConfig`/`StderrConfig` pipe the child's
streams into `Sink`s — which can both accumulate the string *and* call pi's
`onStdout`/`onStderr` per chunk. Timeout, abort, and exit-code handling become
Effect primitives (interruption, `Effect.timeout`, scoped process lifetime).

This is the one recommendation to apply with care: the tree-kill requirement
(the "kills the whole process tree" test) needs `detached` + `process.kill(-pid)`
semantics, which the `ChildProcess` module does not directly expose — keep a
small process-group kill helper for that one behavior, and verify the timeout/
abort tests still settle promptly. Net effect: ~100 lines deleted, and the
`resolveResult`/`timedOut`/`onAbort` flags replaced by the Effect runtime's
own cleanup. (`effect/unstable/process` is unstable — pin the import against
the installed rc.108, and re-verify the API name on the next effect bump.)

---

## Structural Improvements

### 1. Collapse `runOp`'s twenty near-identical `Effect.gen` cases into one bridge

`runOp` (daemon.ts 147–299, ~150 lines) is `Match.tagsExhaustive` over 20 ops,
where 17 cases are the same shape:

```ts
Effect.gen(function* () {
  const outcome = yield* fromEnv(env.someOp(...));
  return outcome.ok ? { ok: true as const, payload: outcome.value } : fail(outcome.error);
})
```

One generic bridge replaces them all:

```ts
const bridge = <T, E extends FileError | ExecutionError>(
  promise: Promise<PiResult<T, E>>,
) =>
  Effect.tryPromise({ try: () => promise, catch: (error) => error }).pipe(
    Effect.map((outcome) =>
      outcome.ok ? { ok: true as const, payload: outcome.value } : fail(outcome.error),
    ),
  );
```

Then `Match.tagsExhaustive` becomes a table of `(op) => Effect` where the
generic cases are one-liners (`read_text_file: ({ path }) => bridge(env.readTextFile(path))`)
and only `exec` (stream wiring + aborter registration) and `read_binary_file`
(base64 encoding) keep explicit bodies. ~100 lines deleted; the `fail` closure
and `fromEnv` stay. The duplicated doc comment above `runOp` (two stacked
blocks, 130–145) and the duplicated `encodePayload` doc (98–113, the same
paragraph appears twice around `OpPayload`) go with it.

### 2. Daemon aborters: `Map<string, () => void>` → `FiberMap<string>` of the op fibers

The connection handler keeps `aborters = new Map<string, () => void>()`
(daemon.ts 310), registers an `AbortController`-aborting closure per `exec`
(200–207), and on close runs `for (const abort of aborters.values()) abort()`
(474–476) — a manual fiber registry. The ops are already forked with
`Effect.runFork` (443); the Effect-native shape is a scoped
`FiberMap<string>` (available in `effect@4.0.0-rc.108`, `FiberMap.make` is
scoped): fork each op with `FiberMap.run(id, effect)`, serve `env_abort` as
`FiberMap.get(id)` + interrupt, drop the `Effect.ensuring(aborters.delete(id))`
(461) for `FiberMap.remove`, and let the connection scope's exit interrupt the
map — deleting the manual close loop entirely. The `aborters` plumbing in
`runOp`'s `ctx` type and `handleEnvConnection`'s `exec` branch shrinks
accordingly.

### 3. `RemoteEnv` base64: hand-rolled → `Effect.Encoding`

`remote.ts` `bytesToBase64`/`base64ToBytes` (157–170, ~18 lines of chunked
`String.fromCodePoint`/`atob` gymnastics with an explicit workerd-compat
comment) are exactly `Encoding.encodeBase64`/`decodeBase64` from the `effect`
package (verified in the installed rc.108: pure, `btoa`-fallback based,
workerd-safe — no `Buffer`). `daemon.ts`'s `Buffer.from(content, "base64")` /
`Buffer.from(outcome.value).toString("base64")` (176, 265, 293) can use the
same module, removing the node-only `Buffer` from the daemon's wire path and
unifying both ends of the binary round trip on one primitive. (The daemon runs
on node, so `Buffer` is not *wrong* — `Encoding` is just the uniform, shared,
workerd-clean choice the remote side already needs.)

### 4. `describeEntry`'s triplicated basename computation

`path.split(pathModule.sep).pop() ?? path` appears three times inside
`describeEntry` (132, 137, 144). Fold into one `basename(path)` helper once the
function becomes an Effect (Critical Issue 2).

### 5. `runRegistration`'s reconnect loop vs `Schedule`

`relay.ts` (119–136) implements the reconnect loop as `while (yield* Ref.get(runningRef)) { runRegistration; log; Effect.sleep(BACKOFF_MS) }` —
imperative timing with a manual backoff. `style.md`'s polling section prefers
`Effect.retry` + `Schedule` (`spaced`/`exponential`/`upTo`) with a `Clock`-fakeable
shape. The current loop is defensible (the loop must also observe `stop()`),
but a `Schedule.spaced(BACKOFF_MS)`-driven retry around `runRegistration` with
`runningRef` consulted in the schedule's `while` would delete the explicit
`sleep` and make the backoff testable. Low priority — the loop works and is
clear.

### 6. `RelayHello`/`RelayAttach` are structurally identical

`protocol.ts` 108–122: two `S.TaggedStruct` schemas with identical fields
(`envId`, `token`, `version`) differing only in tag. One factory
(`const relayFrame = (tag: "relay_hello" | "relay_attach") => S.TaggedStruct(tag, {...})`)
kills the duplication without touching the wire shape. Cosmetic.

---

## Effect Migration

**What must stay promise-shaped (do not touch):** the `ExecutionEnv` interface
methods on `LocalEnv` and `RemoteEnv` — that is pi's contract, and `style.md`
explicitly preserves it ("cross once per method (`Effect.runPromise` inside the
seam method)"). Also `socket.ts`'s `SocketLike` (event-based, not promise-based
— the correct shape for the workerd/node adapter seam) and `paths.ts` (pure).

**What must migrate (all saku-owned async):**

| Location | Today | Target |
|---|---|---|
| `remote.ts` `connect()` 208 | `async → Promise<EnvHelloOk>`, hand-rolled hello state machine + `onceHelloTimer` | `Effect<EnvHelloOk, EnvConnectionError>`, `Deferred` + `Effect.timeoutFail` |
| `remote.ts` `request()` 376 | `async → Promise<RequestOutcome>`, `Effect.runPromise(Effect.callback(...))` | `Effect<RequestOutcome>` over a `Deferred`-keyed pending map |
| `remote.ts` `op()`/`fileOp()` 421/449 | `async` wrappers | Effect pipelines; only the public `ExecutionEnv` methods keep `Effect.runPromise` at the seam |
| `local-env.ts` `describeEntry` 127 | module-level `async` + `runPromise` | pure `Effect<FileInfo, never>` |
| `local-env.ts` `listDir` 301 | `await Promise.all(map(async ...))` | `Effect.forEach(..., { concurrency: "unbounded" })` |
| `local-env.ts` `fileInfo` 280 | `Effect.tryPromise(async () => await describeEntry(...)).pipe(Effect.orDie, ...)` | `describeEntry(...).pipe(Effect.result)` — the `tryPromise`/`orDie` round trip is deleted |
| `daemon.ts` `EnvDaemon.make` server 493 | hand-rolled `Effect.callback<WebSocketServer, Error>` | `listenWs` + `wsUrlOf` from `@saku/wire/server` |
| `local-env.ts` `exec` 390 | `spawn` + timers + abort listeners + killTree in `Effect.callback` | `effect/unstable/process/ChildProcess` + `ChildProcessSpawner` (keep the detached group-kill helper) |

**Consumer migration (owned by `deploy`, `cli`, `hub`, `worker`):** every
`Effect.tryPromise(async () => await env.connect())` disappears — `thread-do.ts:351`
becomes `yield* env.connect()`; `cli/src/env.ts:114` and `box.ts:285` become
`Effect.option`/`Effect.result` over the Effect, with the socket close moved
into a finalizer (fixing the leak-on-failure today). Tests update from
`rejects.toThrow("invalid token")` to asserting `EnvConnectionError.kind`.

---

## Type Safety Improvements

1. **`handleEnvConnection` typed against `SocketLike`** (Critical Issue 3): the
   connection handler becomes transport-agnostic *by type*, not by assertion —
   the `RawData` import leaves daemon.ts, and a future workerd daemon reuses
   the handler without a rewrite. This is the single largest type-safety win:
   the package's central claim ("one protocol, one handler, two transports")
   becomes checkable by the compiler.
2. **`RemoteEnv.connect()`'s failure channel becomes typed** (Critical Issue 1): `Effect<EnvHelloOk, EnvConnectionError>` carries the `kind`
   literal (`rejected`/`hello_timeout`/`socket_error`/...) instead of an
   untyped promise rejection — callers `catchTag` instead of matching message
   text, and the `env-connection-error.ts` schema finally earns its existence
   at the API boundary, not just inside `connect`'s implementation.
3. **`RequestOutcome.error` is `EnvErrorLike` — use the schema's `EnvError`**
   (remote.ts 95, 437): `RequestOutcome`'s failure arm is a loose structural
   `{kind: string, message: string, path?: string}` while the wire error is
   already decoded as protocol's `EnvError` schema type. Typing the pending-map
   outcome as `EnvError` (schema `Type`) makes `toPiError` (protocol.ts 261)
   take it directly and kills the third structural copy of the wire error
   shape.
4. **`describeEntry` fabricates FileInfo on stat failure** (local-env.ts
   140–148): a stat failure reads as a real entry `{kind: "file", size: 0,
   mtimeMs: 0}` — a racing deletion or permission error surfaces as an empty
   file, indistinguishable from truth. pi's contract permits `err(FileError)`;
   with the Effect rewrite, consider failing (or at least logging) instead of
   fabricating, and keep the `listDir`-racing-removal behavior as an explicit,
   documented exception rather than the blanket fallback.
5. **`nodeProcess` global cast** (remote.ts 116) is documented and correct —
   leave it, but it disappears naturally if `connect` gains a `cwd` option
   default resolved at the call site.

---

## Minor Cleanups

- **Duplicated doc blocks in daemon.ts**: the `encodePayload`/`OpPayload`
  comment (98–113) and the `runOp` comment (130–145) each appear twice, stacked.
  Delete the redundant copies (Structural Improvement 1 does this).
- **`TempFileOptions` exists twice with different shapes**: local-env.ts 116
  (`{directory, prefix?, suffix?}` — the FileSystem service shape) and daemon.ts
  126 (`{prefix?, suffix?}` — the wire shape). The daemon's copy is a
  pointless shadow of the wire schema (`create_temp_file` already carries the
  optional fields); delete the daemon's and build the `FileSystem` shape inline.
- **`isText` is defined identically** in local-env.ts 88 and remote.ts 151 —
  one two-line predicate in `protocol.ts` (or the wire package) serves both.
  Same for `isFrame` (daemon.ts 65, remote.ts 147).
- **`serializePiError` (daemon.ts 57) is the inverse of `toPiError` (protocol.ts 261)** — the pair is fine, but consider one `EnvError.fromPi`/
  `toPiError` home in protocol.ts so the wire-error shape has a single
  residence on both sides.
- **`remote.ts` `readBinaryFile`/`listDir` accept `_signal` and ignore it**
  (523–525): required for `ExecutionEnv` conformance; add a comment saying the
  daemon-side abort doesn't apply to file ops (as `readTextLines`/`createDir`
  already document elsewhere) so nobody "fixes" it.
- **`local-env.ts` `joinPath`'s `void this.cwd;`** (186): dead statement
  silencing the unused-field lint. The method is pure; hoist `joinPath` to a
  module function (or a static) and drop the `void`.
- **`nodeSocket.off` ignores the registry's "no listeners left" return** while
  `workerdSocket.off` unregisters the platform listener — harmless asymmetry,
  but a comment would stop someone from "fixing" one side only.
- **Tests**: `env-daemon.test.ts` is a genuinely good integration suite (real
  sockets, no stubs). The `rejects.toThrow("invalid token")` checks (85) become
  `kind` assertions after Critical Issue 1. The version-mismatch test's
  `sleep(100)` (92–94) is the one polling wait — fine for a one-off, but the
  `once`-based open wait above it is the better pattern.
- **`entry.ts` flag parser** is fine; the env.url write/remove best-effort
  `catch → void` is the documented house shape. Leave.

---

## Suggested execution order

1. **`SocketLike`-ify `handleEnvConnection` + `nodeSocketFromWebSocket` adapter**
   (Critical 3) — unlocks everything below on the daemon side; run the full
   env/hub/worker/deploy socket suites (relay.test.ts, remote-host.test.ts,
   deploy.test.ts all exercise this path).
2. **`EnvDaemon.make` → `listenWs`/`wsUrlOf`** (Critical 4) — one commit, plus
   the `wsUrlOf` host parameter in `@saku/wire/server`.
3. **`local-env.ts` Effect-ification** (Critical 2, Structural 4; Type Safety 4) —
   `describeEntry`, `listDir`, `fileInfo` all inside one file; tests already
   cover listDir/fileInfo.
4. **`RemoteEnv` internal Effect-ification** (Critical 1) — `connect`/`request`/
   `op`/`fileOp`, then migrate `thread-do.ts`, `cli/src/env.ts`, `box.ts`, and
   the four test files' `connect()` calls in the same change (no shims).
5. **`runOp` bridge + `FiberMap` aborters** (Structural 1, 2) — daemon.ts shrinks
   by ~150 lines; `env_abort` behavior is pinned by the existing abort/tree-kill
   tests.
6. **`exec` → `ChildProcess`/`ChildProcessSpawner`** (Critical 5) — largest
   behavioral surface; land with the timeout, abort, and tree-kill tests
   green, keeping the detached group-kill helper.
7. **Minor cleanups** (base64 via `Encoding`, `TempFileOptions`, `isText`/
   `isFrame` sharing, doc blocks, `joinPath` hoist).

Do not touch: the protocol schemas and `EnvPayloadSchema` table (the encode/
decode contract is the package's best feature), the promise shape of the
`ExecutionEnv` seam methods, `EnvDaemon`/`EnvRelayClient`'s `Context.Service`
form, `socket.ts`'s registry design, `paths.ts`, and the test suite's
real-socket integration approach.
