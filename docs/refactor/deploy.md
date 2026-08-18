# Refactor report: `packages/deploy`

Scope reviewed: `src/` (1251 lines), `scripts/embed-env-bundle.ts` (40), `alchemy.run.ts` (103), `celld/` (12), tests (`deploy.test.ts` 330, `provisioner-selection.test.ts` 63). Reference patterns: `effect` rc.108 source, `lutra` (`Context.Service` + `Layer` service style), and the saku sibling packages (`hub`, `worker`, `store`, `env`, `wire`).

---

## Overview

`@saku/deploy` is the deployment adapter: plain workerd code that runs the saku control plane inside Durable Objects. The heavy cores are Effect services in other packages (`Hub`, `HubRegistry`, `SkillsStore`, `WireCore`, `HubRelayCore` in `@saku/hub/core`; `SessionHost`, `runSessionCommand`, `createModelCatalog` in `@saku/worker/isolate`) and the deploy package wires them to DO storage via the `KvStore` seam — the correct architecture. `hub-do.ts` hosts the hub; `thread-do.ts` hosts per-thread `SessionHost`s; `rpc.ts`/`do-protocol.ts` are the JSON-over-fetch DO-to-DO protocol; `alchemy.run.ts` + `celld/` are the two deployment targets.

The state is *good*. Schemas are validated at every boundary, errors are tagged and keep their discriminators across the fetch seam, the `Effect.fn`/`{ self: this }` convention is applied consistently, and the platform boundaries (workerd's promise-shaped DO methods, DO storage) are correctly identified as the one place `runPromise` belongs. The problems below are about *where* that boundary is drawn — it has leaked inward — and about duplicated structure that a few judo moves would collapse.

---

## Critical Issues

### 1. Promise/Effect nesting in `thread-do.ts` — the boundary is inside the handlers, not at the edge

`fetch` (line 120) wraps every route in `Effect.tryPromise`, and each `handleX` handler is promise-shaped and calls `Effect.runPromise` *again* internally:

- `handleCreate` (187), `handleSetEnvHandle` (222), `handleCommand` (251) each do `await Effect.runPromise(tryPromise(...).pipe(flatMap(decode)))` to parse the body — three copies of the same shape.
- `handleDelete` (205) and `handleSetEnvHandle` (244) each `await Effect.runPromise(this.host.dispose()...)`.
- `handleCommand` (269) does a third `await Effect.runPromise(this.runCommand(...))`.

That is `runPromise` → `tryPromise` → `runPromise` → `runPromise` stacked in one request path. The Effect runtime is entered and exited four times per command. The fix is a single pass:

1. Make the handlers Effect-based (`handleCreate`/`handleCommand`/`handleSetEnvHandle`/`handleDelete` return `Effect.Effect<Response, ...>`).
2. `fetch` becomes one `Effect.gen` dispatching to them (a `Match` on path, like `runSessionCommand` does for commands) with **one** `Effect.runPromise` at the edge — exactly the posture `hub-do.ts` documents for itself at lines 164–165.
3. The body-parse pattern collapses to one helper (see Structural §1).

### 2. `hub-do.ts` `handlePush` mixes three execution shapes in one function

`handlePush` (228) is a `Match.tagsExhaustive` whose arms return: a `Promise<Response>` built with `Effect.runPromise` inside the arm (`idleStopFired`, 245), a plain sync `Response` that fire-and-forgets via `hub.events` (`report`, `sessionEvent`). Then `sessionEvent` (268) calls `Effect.runSync(Schema.decodeUnknownEffect(...))` — a decode wrapped in a runtime entry for no reason. Make the whole match an Effect (`Effect.gen` yielding `jsonOk`/`jsonError`) with one `runPromise` at the boundary, and use `Schema.decodeUnknownSync(opaque<SessionWireEvent>())(event)` (exists in rc.108) instead of `runSync(decodeUnknownEffect(...))`.

### 3. `hub()` memoization poisons the DO on transient failure

`hub-do.ts:168`: `this.hubPromise ??= Effect.runPromise(this.buildHub())`. If the build rejects once (a transient KvStore read, a provisioner failure), the rejected promise is cached **for the rest of the activation** — every subsequent fetch awaits a rejection that will never resolve. `Hub.make`'s failure channel is real (provisioner selection fails loudly, storage reads can die). The memo should be cache-the-Effect and re-run on failure (e.g. a `Ref<Option<Effect>>`, or clear `hubPromise` in a `.catch`). Same class of issue: `wireCore()`/`relayCore()` use `Effect.runSync` — a failure there throws *inside* `fetch`, surfacing as a 500 (or worse, an unhandled throw in workerd) instead of the envelope's `jsonError`. `buildHub` is already Effect-shaped; the memo should stay Effect-shaped and only the final `fetch` should `runPromise`.

### 4. The ADR 0005 `opaque` schema is defined twice

`hub-do.ts:49` and `rpc.ts:47` each define the identical `opaque<T>()` schema. `@saku/wire` already owns this exact helper (`wire/src/opaque.ts`) — it's just not re-exported. This is a "second convention beside an existing one". Fix: export `opaque` from `@saku/wire` (or, if the deploy package shouldn't depend on wire for it, define it **once** in `do-protocol.ts` and import it in both DO files).

---

## Structural Improvements (code judo)

### 1. `thread-do.ts` is the monolith (463 lines) and repeats itself

The class holds routing, three memoized loaders, three body parsers, host lifecycle, env lifecycle, the registry view, and the event sink. Collapse the repeats before splitting:

- **`parseBody(request, decode)` helper** — the three `tryPromise({catch: () => null, ...}).pipe(flatMap(sync(decode)))` blocks (188, 223, 252) are one function:
  ```ts
  const parseBody = <T>(request: Request, decode: (raw: unknown) => Option.Option<T>) =>
    Effect.tryPromise({ catch: () => null, try: () => request.json() })
      .pipe(Effect.flatMap((raw) => Effect.sync(() => decode(raw))))
  ```
  (`tryPromise({catch: () => null})` is itself just `Effect.option`-shaped — prefer `Effect.tryPromise(() => request.json()).pipe(Effect.option)`.)
- **`disposeHost()` helper** — the `host.dispose().pipe(catch(void))` + `host = undefined` block appears at 207, 244, and 329.
- **One generic memo loader** — `loadThreadId`/`loadRecord`/`loadEnvHandle` (90–112) are the same `if (field !== undefined) return field; read storage; cache` shape three times.
- After those, the file naturally splits: the registry view (`registry(record)`, 417–463) is self-contained (takes a `push` callback) and could live in its own module; `envFor`/`envKeyOf` are an env-connection module.

### 2. `idleStopMs` computed twice; constant cross-imported between DOs

`hub-do.ts:142–145` and `thread-do.ts:87–89` compute the identical `Math.trunc(Number(varOrDefault(env, "SAKU_IDLE_STOP_MS", ...)))`. And `thread-do.ts` imports `IDLE_STOP_DEFAULT_MS` **from `hub-do.ts`** — two sibling DO classes coupled by a constant. Move both the constant and an `idleStopMsOf(env)` helper into `env.ts`, where `varOrDefault` already lives.

### 3. `Effect.catch((e) => Effect.fail(f(e)))` ≡ `Effect.mapError(f)`

`rpc.ts` does the verbose form in `arm`, `disarm`, `create`, `delete`, `setEnvHandle`, `setThreadEnvHandle`, and `command` — seven sites. `Effect.catch((e) => Effect.fail(toHubError(...)(e)))` is exactly `Effect.mapError(toHubError(...))`. And `disarm`'s trailing `.pipe(Effect.result, Effect.asVoid)` is dead weight after the catch already converts to success. Half of `rpc.ts`'s bulk is this pattern.

### 4. The RPC envelope schema lives in the wrong file

`rpc.ts:53` declares `RpcEnvelopeSchema`, but its documented counterpart interface `RpcEnvelope` is in `do-protocol.ts` — the file whose stated purpose is "the single definition of the JSON contract". Move the schema next to the interface; `rpc.ts` can even derive the type: `Schema.Codec.Encoded<typeof RpcEnvelopeSchema>` instead of hand-keeping the interface and schema in sync across files.

### 5. Small structural nits

- `worker.ts:19` hardcodes `"hub"` while `rpc.ts` uses `HUB_INSTANCE` from `env.ts` — use the constant.
- `fetchDo` (rpc.ts:105) takes `(stub, url, body, path)` — `hubRpc`/`threadRpc` differ only in the stub + hostname; the `https://hub.internal` / `https://thread.internal` magic hosts are worth naming constants (they're DO-stub placeholder URLs; the host is ignored by the stub, but the duplication invites drift).
- `threadWorkerRef.close` is a stub (`() => Effect.void`, rpc.ts:194) — the hub's `Hub.close` calls it. Harmless, but say so in a comment or drop the close from the hub contract instead of shipping a silent no-op.

---

## Effect Migration (Promise → Effect)

The platform boundary (workerd DO methods `fetch`/`alarm`, DO storage) is legitimately promise-shaped — the goal is **one `runPromise`/`runFork` at that edge**, which the code itself declares (hub-do.ts:164) but does not consistently do.

| Site | Now | Should be |
|---|---|---|
| `thread-do.ts` `fetch` + handlers (120–270) | `runPromise` ×4, `tryPromise` ×6, promise handlers | One `Effect.gen`, one `runPromise` at the edge; handlers Effect-based |
| `hub-do.ts` `handlePush` (228–275) | mixed promise/sync/`runSync` arms | One Effect, one `runPromise` |
| `hub-do.ts:268` | `Effect.runSync(Schema.decodeUnknownEffect(opaque(...))(event))` | `Schema.decodeUnknownSync(opaque(...))(event)` |
| `pushToHub` (rpc.ts:236) | `void Effect.runPromise(...)` | `Effect.runFork` — hub's own event sinks (`Hub.events`, hub.ts) use `runFork` for fire-and-forget; be consistent |
| `hub()` memo (hub-do.ts:168) | cached rejected promise | cache the Effect; re-run on failure |

Keep promise-based (correctly): `state.storage.*` calls in `thread-do.ts` (platform boundary — mirror `KvStore.doStorage`'s `tryPromise(...).pipe(orDie)` posture), the socket adapters, and `alarm()`.

---

## Type Safety Improvements

1. **`idleStopMs` NaN poisoning.** `Number("garbage")` → `NaN`, which flows silently into `IdleStop`/`setAlarm(Date.now() + NaN)`. Parse with `Schema.NumberFromString` (or `Number.parseInt` + `Number.isFinite` guard) and fail loudly at DO build — the same posture `provisionerFor` already has for unknown provisioner values. `Math.trunc(Number(...))` at hub-do.ts:143 and thread-do.ts:88 should become the shared, validating helper from Structural §2.
2. **`varOrDefault` is good** — `name: keyof DeploymentVars` keeps var names type-checked; extend the same rigor to the idle-stop parse rather than letting `Number()` accept anything.
3. **The `/push` seam asymmetry.** `HubPush` is the *encoded* wire shape (`type`-tagged, `Schema.Codec.Encoded`); the hub decodes to `_tag`-tagged structs. The `encodeKeys({_tag: "type"})` rename is clever and correct — but it's the most subtle code in the package; it deserves the `RpcEnvelope`-style interface doc next to the schema, or a comment on `HubPush` saying "wire shape; decoded type is the TaggedStruct union".
4. `DeploymentEnv.HUB`/`THREAD` required while `provisioner-selection.test.ts` casts `undefined` — acceptable, documented with the SAFETY comment; a `Pick<DeploymentEnv, DeploymentVars>`-shaped test fixture would make the cast unnecessary.
5. `boxProvisioner.readBundle` (hub-do.ts:58) hand-rolls atob→bytes→TextDecoder; `Effect.Encoding` (rc) has `decodeBase64` — optional, the loop is correct and workerd-safe.

---

## Minor Cleanups

- `catalog.ts:33` — `DEPLOYMENT_VARS.find((varName) => varName === name)` on a 5-element array; `includes`/`Set` reads clearer; the list also duplicates `DeploymentVars` — a comment says it "mirrors" it, which is fine, but the two can drift.
- `alchemy.run.ts:8–9` — `import { Random } from "alchemy"` *and* `import * as Alchemy from "alchemy"`; use one.
- `hub-do.ts:229–238` — the "malformed JSON → `catch: () => null`" trick conflates JSON-parse failure with decode failure into one `Option.none`; `Effect.option` on the parse keeps the two distinguishable for logging without changing behavior.
- `thread-do.ts` `alarm()` (179) — a storage failure in `loadThreadId` throws out of `alarm`; workerd retries alarms on throw, so this is a retry loop rather than a crash — worth a comment so nobody "fixes" it into a silent drop.
- `static-provisioner.ts` — `ensure(thread, remoteMachineId, handle)` ignores all three args (deliberate: static mode is deployment-wide). Fine, but the doc comment could say so explicitly since it reads like a bug at first glance.
- `test/deploy.test.ts` — strong suite; `waitFor`'s recursive return annotation is the documented AGENTS.md exception. Leave it.
- `deploy.test.ts:70` `taggedError` alias exists to satisfy oxlint's `Error`-name heuristic — the same trick belongs in `rpc.ts`/`do-protocol.ts` if lint ever complains there, not a new convention.

---

## Priority order

1. **Critical §1–§4** (boundary discipline in thread-do/hub-do, memo poison, opaque dedupe) — the only behavior-adjacent items.
2. **Structural §2–§3** (idleStopMs into env.ts; `mapError` sweep in rpc.ts) — mechanical, big readability win, zero risk.
3. **Structural §1** (thread-do decomposition) — after the small collapses, split the file; do the collapses first or the split will just move duplication.
4. **Type safety §1** (idleStopMs validation) — bundle with Structural §2.
5. **Minor cleanups** — do alongside whatever else touches those files; none are worth a standalone change.

No file approaches 1000 lines (thread-do at 463 is the max), so the decomposition is about cohesion, not size. The package's architecture is right — the work is drawing the promise boundary at the edge and deleting the duplication that the DO's platform shape invited.
