# Refactor report: `packages/hub`

Review of `packages/hub` (2424 lines of source across 17 files: `hub.ts` 425,
`providers/box.ts` 447, `relay-core.ts` 348, `registry.ts` 210, `wire-core.ts`
200, `idle-stop.ts` 179, `server.ts` 130, `remote-machine.ts` 110, `skills.ts`
76, `worker-ref.ts` 73, `hub-error.ts` 44, `index.ts`/`core.ts`/`relay.ts`/
`provisioner.ts`/`socket.ts` < 50 each; plus 2521 lines of tests across 7
files). Ground truth: `docs/style.md` (the house idiom rules), the daemon's
`SakuDaemonLive`/`SakuDaemonTest` layer composition (`worker/src/daemon.ts`),
lutra (`packages/store/src/edit/edit-store.ts` service contract,
`packages/engine/src/encode/layer.ts` promise boundary), and the sibling
reports `docs/refactor/store.md` and `docs/refactor/deploy.md`.

---

## Overview

The hub is the managed-agents control plane (ADR 0001): the durable thread
registry (`HubRegistry` over the `KvStore` seam), the hub-hosted skills store
(`SkillsStore`), the worker seam (`ThreadWorkerRef`), the env-provisioner seam
(`EnvProvisioner`), the idle-stop policy (`IdleStop`), and the wire/relay
transport (the transport-free `WireCore`/`HubRelayCore` + the node `HubServer`/
`HubRelay` adapters). The core is deliberately transport-free; `core.ts` is the
workerd-clean entry the deployment DO (`deploy/hub-do.ts`) drives.

**The good news first — this package is ~85% idiom-correct.** It is a
beneficiary of the same effect-idiom pass `style.md` documents: `Context.Service`
classes with `make` constructors (`Hub.make`, `HubRegistry.make`), consumers
`yield* KvStore`, reads answer `Option` never `undefined`, `Match.tagsExhaustive`
dispatch (`wire-core.ts`), `Schema.toEquivalence` instead of stringify
comparison, `Effect.retry` + `Schedule` polling (`remote-machine.ts`,
`readHostUrl`), `Result.try` listener containment, tagged errors with required
`kind` (`HubError`), and `Effect.forEach` with `concurrency: "unbounded"`. The
only promise crossings are `box.ts`'s `fetch`/`RemoteEnv.connect` — the correct
platform-boundary pattern. **There are no internal Promise APIs left to
convert.**

The real problems concentrate in **`relay-core.ts`** (callback-state ceremony
plus two connection-lifecycle bugs) and **`idle-stop.ts`** (a documented hack
that exists only to support a dead code path), with a tagged-error defect in
`box.ts`, a contract violation in `relay.ts`, and a missing Layer discipline
that makes every composition site repeat itself. None of the fixes grow the
package; most shrink it.

---

## Critical Issues

### 1. `relay-core.ts`: a non-relay first frame leaves the socket open forever

`handleConnection` installs `onFirst`; after the `relay_hello` and
`relay_attach` branches, the code falls through to:

```ts
// Not relay traffic: this socket belongs to the wire server.
```

(relay-core.ts:299) — and does nothing. The socket stays open with `onFirst`
attached, forever, until the client closes. That comment describes a
single-port design that no longer exists: the DO routes `/ws` vs `/relay` by
path (`deploy/hub-do.ts`), and the node spine gives the relay its own port
(`relay.ts`). Any client that connects to the relay and sends an unrelated
frame — a wire client misconfigured with the relay URL, a health probe, a
malicious scanner — holds a live socket indefinitely. In the DO this is a real
leak on the production surface.

**Fix:** mirror the malformed-frame branches — `failSocket(socket, "not relay
traffic")` (which sends an `EnvErrorFrame` best-effort and closes). One line.

### 2. `relay-core.ts`: a waiting worker that closes before pairing leaves stale state

In `attach`'s waiting path, the close handler only clears the buffer:

```ts
socket.once("close", () => {
  buffers.delete(socket);
  socket.off("message", onMessage);
});
```

(relay-core.ts:202) — it never removes the socket from `waitingRef`. The
2-second timeout removes it *only if the env still isn't registered*; if the
daemon registers after the worker closed, `register()` reads `waitingRef`,
finds the dead socket, and calls `pipeBoth(deadSocket, daemon)`. The
worker→daemon pipe's `onClose` was already consumed by the earlier close (the
handler registered too late), so `detachFromWorker` never runs and the daemon
socket is never closed on worker drop — a half-wired pipe whose cleanup is
permanently skipped.

**Fix:** call the same removal the `drop` path uses from the close handler
(`detachFromWorker(envId, socket)`), and have `register` skip sockets that are
already closed (`socket.readyState` check or a `closed` flag set on close).

### 3. `box.ts`: `JSON.parse(text)` outside any try — a non-JSON body is a raw defect, not a `BoxError`

```ts
const parsed = yield* Schema.decodeUnknownEffect(EnvelopeSchema)(JSON.parse(text)).pipe(
  Effect.result,
);
```

(box.ts:102). `JSON.parse` throws synchronously inside the generator, so a
non-JSON response body (a proxy HTML error page, a gateway 502 body, a
misbehaving Box) surfaces as an unhandled `SyntaxError` defect — not the
tagged `BoxError` every other failure in this file produces. It dies the
provisioning effect instead of failing it. This violates `style.md`'s
"boundary settling" and "No plain `Error`" rules: `EnvelopeSchema` was
explicitly written with every field optional "so an unparseable body degrades
to an empty envelope instead of failing the request" — but the `JSON.parse`
in front of it defeats that design.

**Fix:** `yield* Effect.try(() => JSON.parse(text)).pipe(Effect.mapError(...))`
→ `BoxError` (message: `box api ${method} ${path} unparseable body`), then
feed the parsed value to the schema decode.

### 4. `relay.ts`: `HubRelay.close` doesn't close the server — the API contract lies

```ts
const close = () => core.close();
```

(relay.ts:31). `HubRelayApi.close` is documented "Stop the relay: drop all
sockets, **close the server**" — but this only drops the sockets (`core.close`).
The listening `WebSocketServer` stays up until the surrounding scope closes
(`listenWs`'s interruption finalizer). Compare `HubServer.close`
(server.ts:88-104), which explicitly closes the server via
`Effect.callback(server.close(...))`. A caller that closes the relay and
reopens it (the local spine restarting the env relay) leaks the port. The
tests never catch it because they tear down via `Scope.close`.

**Fix:** mirror `HubServer.close` — hold the server in a `Ref`, close it in
`close()` (or extract the shared helper, Structural Improvement 4).

---

## Structural Improvements (code judo)

### 1. `idle-stop.ts`: delete the mutual-recursion hack — the `fire → arm` re-arm is dead code

```ts
const onFireBeforeAssignment = () => Effect.void;
...
let fire: IdleStopApi["fire"] = onFireBeforeAssignment;   // line 81
...
fire = Effect.fn("fire")(function* (threadId: string) {   // line 140
  ...
  if (Option.isSome(info) && info.value.state !== "idle") {
    yield* arm(threadId);                                 // line 150 — the ONLY reason `let` exists
    return;
  }
```

The `let` + no-op stand-in exists solely to break the `arm ⇄ fire` cycle. But
the cycle is fake: `fire` reaches line 150 only when `state !== "idle"`, and
`arm`'s own gate (lines 93-97: "Never while a run is in flight" — it returns
when `state !== "idle"`) makes that call a no-op **exactly when it is
reached**. The test suite pins this: "does not fire mid-run" asserts
`controller.armed` stays `[]` and comments "arm's own gate skips working
threads; the run's reports re-arm when it settles" — which is precisely why the
re-arm is unnecessary: `applyReport` arms on the worker's idle report.

**Fix:** delete line 150. `fire` no longer references `arm`, so there is no
cycle: define `fire` as a plain `const` before `arm`, and delete
`onFireBeforeAssignment`, the `let` binding, and the "mutual-recursive" comment
(~10 lines of hack removed). The timer closure in `arm` references the
already-assigned `fire` — no ordering problem. Behavior is identical; the
idle-stop suite covers every arm/disarm/fire transition.

### 2. `relay-core.ts`: replace the `Ref` + `runFork`/`runSync` ceremony with plain `Map`s

Every mutation of `envsRef`/`waitingRef` happens inside synchronous socket
event callbacks, and every mutation is wrapped in
`Effect.runFork(Ref.update(...))` (lines 108, 124, 183, 193, 220, 238) or read
with `Effect.runSync(Ref.get(...))` (lines 165, 208, 232) — ten ceremony sites
for single-threaded state. The code already proves the simpler shape: the
`buffers` map is a plain `Map<SocketLike, string[]>` (line 121). `Ref` buys
nothing here — there is no cross-fiber concurrency, and the forks are never
awaited, so the refs' atomicity is unobservable.

**Fix:** `envsRef` → `Map<string, SocketLike>`, `waitingRef` →
`Map<string, Set<SocketLike>>`, `closedRef` → `boolean`; `registered()` becomes
`Effect.sync(() => [...envs.keys()])`; `close` reads the maps inside
`Effect.sync`. Deletes ~30 lines of `runFork`/`runSync`/`Ref` imports and
makes the single-threaded invariant obvious by construction. This also makes
Critical Issues 1 and 2's fixes land in one place.

### 3. Composition: `Hub.make` should `yield* HubRegistry` / `yield* SkillsStore`; the services need Layer factories

`HubDeps` takes `registry` and `skills` as already-built plain arguments, so
every composition site repeats the same two-step build:

```ts
const registry = yield* HubRegistry.make().pipe(Effect.provide(KvStore.memory()));
const skills = yield* SkillsStore.make().pipe(Effect.provide(KvStore.memory()));
const hub = yield* Hub.make({ provisioner, registry, skills, workerRef });
```

— in `hub.test.ts`, `hub-wire.test.ts`, `idle-stop.test.ts`,
`hub-real-worker.test.ts`, and `deploy/hub-do.ts` (five copies). The daemon
package already shows the house pattern: `SakuDaemonLive`/`SakuDaemonTest`
are `Layer.effect` compositions that `yield*` their services (`ThreadRegistry`,
`ModelCatalog`, `FileSystem`, `Paths`) from context. The hub has **zero**
`Layer` usage in the whole package.

**Fix:** give `HubRegistry` and `SkillsStore` static layer factories
(`Layer.effect(HubRegistry, HubRegistry.make())`, same for `SkillsStore`), and
have `Hub.make` drop them from `HubDeps` and `yield*` them instead. `HubDeps`
shrinks to the genuinely deployment-specific seams (`workerRef`, `provisioner`,
`idleStop`, `idleStopMs`), and `hub-do.ts`'s `buildHub` collapses to
`Hub.make({ ... }).pipe(Effect.provide(KvStore.doStorage(state.storage)))` —
the `KvStore` provide stays at the boundary, which is exactly where it belongs.
No test breaks: nothing constructs `Hub` with a non-default registry/skills
today (the policy tests fake at the `IdleStop.make` level, not the `Hub` level).

### 4. The "wait for `server.close()`" dance is triplicated

`Effect.callback((resume) => { server.close(() => { resume(Effect.void); }); ... })`
appears in `server.ts` (96-100) and `worker/daemon.ts` (601-609), and Critical
Issue 4 would add a third copy in `relay.ts`. `@saku/wire/server` already hosts
the other server-lifecycle helpers (`listenWs`, `wsUrlOf`); add `closeWs(server)`
next to them and migrate all three call sites.

### 5. `relay-core.ts`'s 2-second grace window is a raw `setTimeout` (line 207)

Not fakeable with `TestClock` (a `style.md` value — the polling cleanup exists
precisely so `Clock` can fake time), and it can't be cancelled: a worker that
pairs within the window leaves a wasted 2-second timer running per attach.
Prefer `Effect.fork(Effect.sleep("2 seconds").pipe(...))` with a per-socket
scope (cancellable on close), or at minimum clear the timeout when the socket
closes.

### 6. `box.ts` (447 lines) mixes three concepts in one file

The raw HTTP client (`BoxApi`), the provider lifecycle (`BoxProvisioner`), and
the bootstrap shell templates (`remoteSystemdUnit`, `boxRunScript`,
`remoteEnsureNodeCommand`, `remoteInstallCommand` — ~60 lines of untested
string builders). `style.md`'s file-shape rule names the model:
`session-host.ts` at 1149 lines became four modules. Split into
`box-api.ts` / `box-bootstrap.ts` / `box-provisioner.ts`. Optional (under the
1000-line cap), but the scripts have no relationship to the client and no
tests, so they'd be easy to lose in the client's diff noise.

---

## Effect Migration (Promise → Effect)

**Honest headline: there are no internal Promise APIs left to convert.** The
package is already fully Effect-shaped — no `Effect.promise`, no
`async`/`Promise` in `src/` except `box.ts`'s platform-boundary `fetch` and
`RemoteEnv.connect`, both crossed correctly with `Effect.tryPromise` + tagged
`catch` mapping (`style.md`'s "at a platform promise edge, cross with
`Effect.tryPromise` + `catch` mapping"). The real remaining work is
Effect-idiom:

1. **`box.ts` `JSON.parse` defect → tagged `BoxError`** (Critical Issue 3) —
   the one place a raw platform throw leaks through as a defect.
2. **`relay-core.ts` `runFork`/`runSync` `Ref` ceremony → plain state**
   (Structural Improvement 2) — not promise→effect, but removing the
   effect-wrapping of synchronous state.
3. **`Effect.catchIf(() => true, () => Effect.void)` → `Effect.ignore`** —
   three sites (`hub.ts` 230, 247; `idle-stop.ts` 111). Identical semantics
   (both catch typed failures, propagate defects); `Effect.ignore` is the
   named idiom for "fire-and-forget best-effort".
4. **relay's `setTimeout` → `Effect.fork` + `Effect.sleep`** (Structural
   Improvement 5) for `TestClock`-fakeable grace windows.
5. **Already covered elsewhere — do not duplicate:** `deploy/hub-do.ts`'s
   `handlePush` mixing three execution shapes and the promise memoization
   (`buildHub` cache) are documented in `docs/refactor/deploy.md`; that
   package owns them.

---

## Type Safety Improvements

1. **`HubEvent.session_event.event: unknown` → `SessionWireEvent`**
   (hub.ts:57). The sink that feeds it (`HubEventSink.sessionEvent`,
   worker-ref.ts) is already typed `SessionWireEvent`; hub.ts already imports
   `type { ... } from "@saku/wire"`; and the wire client decodes the same
   event with `opaque<SessionWireEvent>()` (wire/client.ts:265). The `unknown`
   at the middle of the fan-out is a needless lossy narrowing — ADR 0005's
   opaque boundary lives at the DO/sink decode, not here. Free win: the
   hub's `notify`/`broadcast` path stops discarding the event's type.
2. **`HubRecord` and `SkillInfo` need `Schema.Struct` definitions.** They are
   plain interfaces today, and store.md's Critical Issue 1 (schema-typed
   `jsonRecords`) is blocked on them — the hub's `registry.ts` and `skills.ts`
   are the biggest `jsonRecords` consumers. Cross-referenced with
   `docs/refactor/store.md`; land together.
3. **`relay-core.ts`'s `SocketPayload` derivation is a type-tetris quote**
   (line 28: `Parameters<Parameters<SocketLike["on"]>[1]>[0]`). Export a named
   `SocketPayload` type from `@saku/env`'s socket surface (`socket.ts` already
   re-exports the surface) and import it.
4. **`RemoteMachineProviderError`'s `{ _tag?: string }` duck-typing**
   (`isRemoteMachineNotReady` in remote-machine.ts) works but rots silently if
   a provider's error shape drifts. `box.ts` already shows the better shape —
   a declared `_tag` literal + type predicate (`HostUrlPending`). Give the
   ready-state sentinel the same treatment. Optional.
5. **`wire-core.ts`'s `create_thread` builds its input with four
   conditionals** (line 86 onward). `Schema.optional` fields are `| undefined`, so
   one object literal `{ name: command.name, cwd: command.cwd, mode:
   command.mode, autoName: command.autoName }` typechecks against
   `Parameters<HubApi["createThread"]>[0]` — 8 lines → 1, and the wire payload
   stays exhaustive by construction.

---

## Minor Cleanups

- **Test helper triplication:** `tagged`/`TestError`/`waitFor` are
  copy-pasted into five test files, and `makeWorld` into two
  (`hub.test.ts` + `idle-stop.test.ts`). A shared `test/helpers.ts` (the
  files already share `mock-worker.ts`) cuts ~80 lines and one repeated
  explanatory comment ("Aliased so the TaggedError class declaration stays a
  plain call...") that appears verbatim four times.
- **`box.ts` `probeDaemon` leaks the `RemoteEnv` on probe failure:** when
  `env.connect()` throws, `env.close()` is skipped. Wrap in
  `Effect.acquireRelease` (or connect-then-close with a `try`-style
  finalizer) so a failed probe doesn't strand a socket.
- **`relay.ts`'s `listenWs` `onError` returns the raw `Error`** as the
  failure channel (untagged). `HubServer` wraps it into `HubError`
  (kind `startup`) at its own boundary, so it's contained — but the relay's
  own failure shape is untyped. Fine to leave once the `closeWs` helper
  (Structural Improvement 4) lands; don't add a new error type for it.
- **`hub.ts`'s `importSkill`/`deleteSkill`/`listSkills` are one-line
  delegations** — keep them. They're the `HubApi` façade and the positional/
  object-arg reshaping is deliberate.
- **Tests use `Effect.promise(async () => await fn())` in `waitFor`** — the
  promise crossing is the test's own async boundary (the fn is genuinely
  async), so it's acceptable per the style rule; just don't copy it into
  `src/`.
- **`registry.ts` `create` writes the store before updating the refs** — fine
  today (a store failure dies, leaving refs untouched); keep the order, don't
  "fix" it.
- **`Effect.fn` inner names** (`"notify"`, `"applyReport"`, `"ensureEnv"`,
  `"resolveThreadId"`) are generic but consistent with the codebase's
  qualified `"Hub.make"`/`"IdleStop.make"` convention for constructors — the
  tracing value of qualified names only matters at the make boundary; leave
  them.

---

## Suggested execution order

1. **`relay-core.ts` rewrite** (Critical 1 + 2, Structural 2 + 5, Type Safety
   3): plain `Map`s, close non-relay frames, close-handler cleanup, named
   `SocketPayload`, `Effect.fork`/`Effect.sleep` grace window. Self-contained;
   `relay.test.ts` covers every path including the attach-before-register race.
2. **`idle-stop.ts` dead-arm removal** (Structural 1): delete the
   `onFireBeforeAssignment` hack; `idle-stop.test.ts` pins the behavior.
3. **`HubRelay.close` + `closeWs` helper** (Critical 4, Structural 4): touches
   `@saku/wire/server`, `worker/daemon.ts`, `hub/server.ts`, `hub/relay.ts` —
   one mechanical commit, all three call sites migrated (no shims).
4. **`box.ts` `JSON.parse` → `BoxError` + `probeDaemon` acquireRelease**
   (Critical 3, Minor).
5. **`HubEvent` typing + `create_thread` literal** (Type Safety 1, 5) — two
   small diffs, zero behavior change.
6. **Layer composition** (Structural 3): `HubRegistry`/`SkillsStore` layer
   factories, `Hub.make` yields them — touches `deploy/hub-do.ts` and the four
   test files. Land with the store.md `jsonRecords` schema migration (Type
   Safety 2) since both touch the registry/skills constructors.
7. **`Effect.ignore` ×3 + test helpers + `Effect.sleep`** (Minor) — mechanical
   polish, last.

Do not touch: the `Context.Service` + `make` construction shape, the
`Option`-answering seam shapes (`HubRegistryApi`, `SkillsStoreApi`,
`HubEventSink`), the `Match.tagsExhaustive` routing in `wire-core.ts`, the
`Result.try` listener containment, or `box.ts`'s `tryPromise` platform
boundary — all correct and tested.
