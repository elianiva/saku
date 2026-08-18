# Refactor report: `packages/wire`

Scout: full read of every `src/` and `test/` file in the package (2211 lines:
`src/` 15 files, `test/` 4 files), cross-checked against Effect's own API
surface (`~/Development/repos/effect/packages/effect/src`, installed
`effect@4.0.0-rc.108`), the lutra reference
(`~/Development/personal/apps/lutra/packages`), the house rules in
`docs/style.md`, and the consumers (frontend `wire.ts`, `cli/src/entry.ts` +
`daemon.ts`, `hub/src/wire-core.ts`).

## Overview

`@saku/wire` is the typed, versioned wire protocol of the whole system: the
JSONL-over-WebSocket vocabulary consoles (foldkit frontend, CLI) exchange with
the hub and, transitionally, the local daemon. It is organized by protocol
feature, not technical layer — `version`, `hello`, `thread`, `session`,
`skills`, `pi-sessions`, `projects` (schema-defined vocabularies), `envelope`
(top-level frames), `transport` (JSONL framing), `client` (the console side:
an effect-machine actor), `server-core` (the transport-free server discipline
shared by hub and daemon, exported via the `@saku/wire/server` subpath so the
frontend bundle never sees node-only `ws`), and `ws-server` (the node
listener helper).

**The good news first — like `@saku/store`, this package is already ~90%
idiom-correct.** It was written after the effect-idiom pass `style.md`
documents, and it shows:

- **Zero `async`/`Promise` in `src/`** — the promise rule is honored; the only
  crossings are the WHATWG `WebSocket` callback edge (the platform boundary,
  correct) and `Effect.runPromise` in tests (the test seam, correct).
- Schemas (`Schema.Struct`/`TaggedStruct`) for every wire contract; pi's types
  cross opaque per ADR 0005 via `opaque.ts`, deliberately never re-schemed.
- Tagged errors everywhere (`WireError` with `code` literals, `WireServerError`,
  `WsServerError`) — the house model, each with a single source of truth for
  its discriminators.
- `Match.tagsExhaustive` for all tagged-union dispatch; no `switch`/`default`.
- `Result.try` for listener containment (`emit`), `Effect.option`/`Effect.result`
  for boundary settling, `Ref`/`Deferred` for correlation, `Context.Service`
  with `{ make }` for `WireClient`/`WireServer` — exactly the patterns
  `style.md` names ("`WireServer.make`, `WireClient.make`" are cited as the
  house pattern for effect-returning constructors).
- The command surface is DRY by construction: one `COMMANDS` registry row per
  command (schema, thread scoping, response extractor), with every client
  method a thin derivation of its row.

The dependency graph is clean and acyclic: feature leaves → `envelope` →
`transport` → `client`/`server-core`. File sizes are healthy — the largest,
`client.ts`, is 830 lines, under the ~1000 cap; no file needs splitting for
size. The tests are excellent: property tests pin the transport's total
contract, an integration suite proves the protocol end to end against the
shipped `WireServer` core, and a fast-check model test proves the thread
lifecycle under arbitrary op sequences.

So this report is not about rescuing a broken package. The issues below are the
remaining seams where the code lies to itself, the dead guard, the duplicated
workaround, and the structural lines that would make `client.ts` dramatically
easier to hold in one head.

## Critical Issues

### 1. `isSocketMessage` is a type guard that provably returns `true` — a dead filter that hides a silent drop

`transport.ts`:

```ts
/** Whether a raw message is a wire frame payload (text or a binary view). */
export const isSocketMessage = S.is(opaque<SocketMessage>());
```

`opaque<T>()` is `S.declare<T>((_u): _u is T => true, ...)` — its predicate
**always returns true**. `Schema.is` runs the predicate, so `isSocketMessage`
returns `true` for *any* input, including `null`, numbers, and Blobs. It is a
no-op at both call sites:

- `client.ts` `Connecting` spawn: `if (isSocketMessage(data)) { ... }` never
  filters; a Blob passes the guard, then `decodeFrame` throws `WireFrameError`
  inside `Result.try`, and the `if (Result.isSuccess(line))` drop-path silently
  discards it — **no error event, no failed pending, nothing**. The client's
  inbound-decode failure path is invisible.
- `server-core.ts` `onMessage`: `if (!isSocketMessage(data)) return;` never
  returns early; a Blob reaches `decodeFrame`, throws, is caught by
  `Result.try`, and is answered with `"malformed JSON frame"` — the *wrong*
  message (it is not malformed JSON; it is a rejected binary type).

The refinement `data is SocketMessage` is asserted, never checked — the exact
"cast that rots silently" shape `style.md` bans. The comment says the guard
means "text or a binary view", but the type `SocketMessage` includes Blob, and
the guard checks nothing at all.

**Fix (choose one):** (a) make the guard honest:
`typeof data === "string" || data instanceof ArrayBuffer || ArrayBuffer.isView(data)`
— then both call sites do real filtering and the Blob case is excluded up
front; or (b) delete `isSocketMessage` and route `decodeFrame`'s `WireFrameError`
into the existing error channels. Either way, make the **client's silent drop
path emit an error event**, mirroring `server-core` (see issue 3). This is the
one real "lies to the reader" defect in the package.

### 2. `Effect.runSync` of an always-true schema inside Effect programs — casts dressed as runtime work

Two sites decode with `Effect.runSync(Schema.decodeUnknownEffect(opaque<...>()))`:

- `client.ts` `handleFrame` (the `event` arm): `Effect.runSync(Schema.decodeUnknownEffect(opaque<SessionWireEvent>())(eventFrame.event))` — a synchronous decode *inside* the machine's `Effect.fn`, of a schema that always succeeds.
- `transport.ts` `decodeJson`: `Effect.runSync(S.decodeUnknownEffect(opaque<JsonValue>())(value))`.

Both are identity functions with ceremony — the type is asserted, nothing is
checked (by design, ADR 0005). The smell is the *form*: `runSync` inside an
Effect program is one wrong step from a defect (if the opaque schema ever
becomes a real schema, `handleFrame` defects the actor), and it hides the
"this is a cast, not a decode" intent from reviewers.

**Fix:** use the total decode form at module scope:
`Schema.decodeUnknownSync(opaque<SessionWireEvent>())` / `Schema.decodeUnknownSync(opaque<JsonValue>())`.
Same intent, zero runtime risk, no `runSync` nested in a fiber.

### 3. The client drops inbound decode failures silently — server and client disagree on error surfacing

In `client.ts`'s socket listener:

```ts
if (isSocketMessage(data)) {
  const line = Result.try(() => decodeFrame(data));
  if (Result.isSuccess(line)) {
    void Effect.runFork(self.send(ClientEvent.Frame({ line: line.success })));
  }
}
```

A decode failure (a Blob, per issue 1, or any future `decodeFrame` throw) is
dropped with no `error` event — while the *server* answers the same condition
with `ErrorEvent "malformed JSON frame"` and the client's *own* `decodeFrameLine`
(used on the `Frame` event path) emits `"malformed JSON frame from server"`.
Three different behaviors for one condition, one of them silent. A console
subscribed to `error` events (the frontend's offline handling) never learns the
connection is receiving garbage.

**Fix:** emit `deps.emit("error", { message: "..." })` (or send a
`ClientEvent` that the machine turns into an error event) on decode failure
before dropping. Then the client's inbound contract is total: every raw
message either becomes a frame or an error event.

### 4. `runConnection` never removes the `message`/`error` socket listeners — a scope close leaves a live callback

`server-core.ts` `runConnection` registers `socket.on("message", onMessage)`
and `socket.on("error", onError)` and never `off`s them. Only the `close`
listener is removed (via the `Effect.callback` finalizer). If a connection
scope closes **without** the socket closing (a caller interrupts the
`Effect.scoped(core.runConnection(socket))` fiber directly, which the
daemon/hub do not do today but the API permits), the socket keeps firing
`onMessage`, which keeps forking `handleHello`/`handleCommand` effects on a
client that is no longer tracked in `clientsRef` — orphaned handlers, silently
muting real connections' traffic interleaved with stale ones.

**Fix:** wrap all three registrations in one `Effect.acquireRelease` (the
pattern lutra's `Stream.callback` + `acquireRelease` uses for listener
registration) so scope close removes `message`/`error`/`close` together, or
collect the `off` closures into the existing close-finalizer. Small, and it
makes the scope's lifetime the socket's contract, which the header already
claims ("Handle one accepted socket for its lifetime (scope closes on close)").

### 5. `handleCommand` dispatches through a `let run;` with `Effect.matchEffect` — the one mutable-dispatch in the package

`server-core.ts`:

```ts
let run;
if (isSessionCommand(command.command)) {
  run = command.threadId === undefined ? Effect.fail(...) : options.handlers.runSessionCommand(...);
} else {
  run = options.handlers.runHubCommand(command.command);
}
yield* Effect.matchEffect(run, { onFailure: ..., onSuccess: ... });
```

Works, but it is the only `let`-then-assign dispatch in the wire, and the
type must be inferred twice. A single expression is both shorter and total:

```ts
const run = isSessionCommand(command.command)
  ? command.threadId === undefined
    ? Effect.fail(new WireServerError({ code: "missing_thread_id", ... }))
    : options.handlers.runSessionCommand(command.threadId, command.command)
  : options.handlers.runHubCommand(command.command);
```

(The `threadId === undefined` guard is itself a protocol check that could live
in the schema — `WireCommand` declares `threadId` optional, so a session
command without one passes decode and is caught here by hand. Either keep the
guard and note it, or split `WireCommand` into session/hub frame schemas so the
violation is a decode failure. The latter is more churn; the ternary is the
free win.)

## Structural Improvements

### 1. `client.ts` at 830 lines mixes three concerns — split along the machine/registry seam

The file is under the ~1000 cap, so this is cohesion, not size. It holds (a)
the connection machine — `ClientState`, `ClientEvent`, all transitions, the
spawned socket wiring (~330 lines), (b) the command registry — `CommandSpec`,
`command()`, `COMMANDS` (~70 lines), and (c) the public surface —
`WireClientApi` (40 methods) + `make` + `request` plumbing (~350 lines).
These are three audiences: the machine is internal, the registry is the DRY
core, the API is the contract consoles code against. Mirror the
`session-host.ts` split (`docs/style.md` File shape): `client/machine.ts`
(state/event/transitions + `ClientDeps`), `client/commands.ts` (registry +
`WireClientApi`), `client.ts` (make + exports). Pure file moves, no behavior
change, and it makes the two hardest-to-read sections (machine transitions,
command derivation) reviewable independently.

### 2. Derive `WireClientApi` from `COMMANDS` — close the two-sources-of-truth gap

Today every command's shape exists twice: once in the `COMMANDS` row
(`createThread: command(false, "create_thread", CreateThreadCommand, (p) => p.thread)`)
and once in the handwritten `WireClientApi` method
(`createThread: (name, options?) => Effect.Effect<ThreadInfo, WireError>`). The
tag strings (`"create_thread"`) and argument shapes are duplicated, and nothing
compiles if the two drift (rename the row's tag and the interface still
typechecks against the old server response). A mapped type over `COMMANDS`
(each row carries `make` args + `extract` result; `WireClientApi` is
`{ [K in keyof COMMANDS]: (args...) => Effect<Extract<...>, WireError> }`)
would make the registry the single definition. Caveat: the handwritten
interface is the *readable public contract* — if the derived type reads worse
than the current interface, keep the interface and instead add a compile-time
consistency check (a `satisfies` mapping from method name → row tag). Either
way the registry and the API should be one edit site per command.

### 3. `ResponsePayload` lives in `session.ts` but unions all features — a naming lie

The union of *every* response payload (session + thread + skills + pi-sessions
+ projects) and the `SessionResponse<K>` extractor sit in `session.ts`, whose
header says "the wire's session feature". The package's own `index.ts` exports
it as a top-level concept. The responses are the one cross-feature artifact;
either rename the module's contract in a header note or move
`ResponsePayload`/`SessionResponse` to a small `payload.ts` and let
`session.ts` import its own responses back. Low churn — the imports are
already centralized — and it makes the layer diagram honest.

### 4. `ThreadState`'s literal list is duplicated — two sources of truth for the state axis

`thread.ts` declares `ThreadState = S.Literals(["idle", "working",
"interrupted"])`; `session.ts`'s `ThreadSessionState` re-declares the same
list inline: `state: S.Literals(["idle", "working", "interrupted"])`. The
comment on `ThreadState` even documents the lifecycle (`idle`/`working`/
`interrupted`) that `ThreadSessionState.state` carries verbatim. If the axis
grows a fourth state, both sites must change. Fix: import `ThreadState` into
`session.ts` and reuse it.

### 5. The `tagged` oxlint workaround is copy-pasted five times with the same comment

`wire-error.ts`, `wire-server-error.ts`, `ws-server.ts`, `hub-fixture.ts`,
`wire.test.ts` each carry:

```ts
// Aliased so the TaggedError class declaration below stays a plain call
// (oxlint's throw-new-error would demand `new`, ...).
const tagged = Schema.TaggedError;
```

Five identical four-line workaround blocks for one lint rule. This is a config
fix, not a code fix: either disable the rule for `Schema.TaggedError` calls
(oxlint supports per-file/rule exemptions) or put the alias in one shared
module. The repetition is the smell of a rule fighting the schema API.

### 6. The hub fixture is a second implementation of the hub contract — acknowledge or shrink the drift surface

`test/hub-fixture.ts` re-implements the hub's ~20-branch `runHubCommand`
match (mirroring `hub/src/wire-core.ts`), with real repetition inside it: six
branches fail with a local-daemon-only shape (`projects_not_served` ×4,
`pi_sessions_not_served` ×2) and five fail with `unknown_thread`. This is the
*correct* isolation tradeoff (wire must not
depend on hub), and the model-based test proves the value — but the fixture
can drift from the hub's actual handlers silently. Two cheap wins: (a) collapse
the repeated `Effect.fail(new FixtureError({...}))` arms into a `notServed(kind,
message)` helper; (b) leave a header note that `wire-core.ts` is the drift
partner, so a hub handler change prompts a fixture review.

### 7. `broadcast` fans out serially — `style.md` says independent iterations are unbounded

`server-core.ts` `broadcast` uses `Effect.forEach(clients, ..., { discard: true })`
without `concurrency: "unbounded"`, serializing the fan-out. The sends are
synchronous today (a slow `send` is unlikely), but the house rule is explicit
("Independent iterations — `Effect.forEach(..., { concurrency: "unbounded" })`")
and the fix is one option.

## Effect Migration

**Honest headline: there are no Promise APIs left to convert.** `src/` has
zero `async`/`Promise`; every API is Effect-typed end to end
(`WireClientApi` methods, `WireServerApi`, `WireServerHandlers`). The style.md
promise rule is satisfied by construction. The remaining work is Effect-idiom
tightening, not promise→effect:

1. **`Effect.runSync` → `Schema.decodeUnknownSync`** (Critical 2) — the two
   opaque-decode sites become total, dependency-free sync decodes. This is the
   only "convert this call shape" item.
2. **The WHATWG `WebSocket` boundary stays as-is, but can be collapsed.** The
   `Connecting` spawn's four `void Effect.runFork(self.send(...))` socket
   callbacks (open/message/close/error) are the correct platform-edge pattern
   (callback → actor event), but they repeat the same fork shape four times and
   leave listeners unremoved until the socket dies. A small `wireSocket(socket,
   self)` helper (register all four, keep the actor events) removes the
   repetition; pairing it with the `acquireRelease` from Critical 4 makes the
   socket's lifetime explicit instead of incidental.
3. **`runConnection`'s `Effect.callback` wait-for-close is right** — keep it;
   just fold the listener cleanup in (Critical 4).
4. **`CLOSE_PAYLOAD` / `NO_PAYLOAD` constants are ceremony.** They exist so
   `Effect.callback<undefined>` resumes can pass a value, but `undefined` is a
   perfectly valid argument; the constants (defined in `client.ts`, `server-core.ts`,
   and `wire.test.ts` — three definitions of "the close event's payload:
   nothing") add nothing. Pass `undefined` directly or drop the payload
   entirely.
5. **Test `runPromise` usage is the seam, not a smell** — `wait()` /
   `Effect.runPromise(...)` in `wire.test.ts` is exactly where the promise rule
   allows crossing. Leave it.

## Type Safety Improvements

1. **`isSocketMessage` (Critical 1)** — the single largest type-safety lie in
   the package: an asserted-but-never-checked refinement that admits every
   value while claiming `data is SocketMessage`. Fixing the predicate makes the
   guard real and the Blob case explicit.
2. **`WireServerHandlers` error type is `unknown`** — honest at the boundary
   (handlers are the hub's `HubError`, the daemon's `DaemonError`), but it
   forces `messageOf` stringification at the frame edge and gives `run`/`runHubCommand`
   no shared shape. Optional: a common `WireFailure` interface
   (`{ message: string }`-shaped tagged error) that both handler types satisfy,
   so `respondCommandFailure` can `catchTag` instead of stringify. Only worth
   it if a handler ever needs to *distinguish* failure classes at the wire —
   today nothing does.
3. **`CommandSpec.schema.make` returns the wide union** `SessionCommand |
   ThreadCommand | SkillCommand | PiSessionCommand | ProjectCommand` — the
   response is typed precisely via `K`/`extract`, but the request side is a
   union. A type-level refinement (make returns exactly the command whose
   response tag is `K`) is possible but adds complexity for no current payoff;
   the registry + `SessionResponse<K>` already pin the response side. Leave it.
4. **`resolveThread` fails with a bare `string`** — the wire's only non-tagged
   failure (`Result<T, string>` in `thread.ts`). It is a pure helper (the CLI
   wraps it into `CliError`), so this is acceptable; if it ever crosses an
   Effect boundary, tag it (`ThreadResolutionError` with an
   `ambiguous`/`not_found` literal). Low priority.
5. **`ThreadInfo` uses `S.Union([S.Null, S.String])` where `Schema.NullOr`/
   optional would read better** — a consistency nit against the rest of the
   package's schema style; not a correctness issue.

## Minor Cleanups

- **`package.json` says `0.1.0`; `WIRE_VERSION` says `"0.3.0"`** — likely
  intentional (protocol version vs package version are independent axes) but
  undocumented. One comment in `version.ts` naming the two axes removes the
  "is this a bug?" question.
- **Inbound decode failure is silent on the client but loud on the server**
  (Critical 3) — already listed; it belongs in the same commit as the
  `isSocketMessage` fix.
- **Concurrent `connect()` calls race on `connectRef`** — the first caller's
  `Effect.ensuring(Ref.set(connectRef, Option.none()))` can clear the *second*
  caller's deferred (whose `Deferred.await` then hangs until timeout). The
  contract says "Connect once per process", so this is a documented edge, not a
  bug — but a one-line guard (`connectRef` already held → fail with
  `disconnected`) makes the contract enforced instead of assumed.
- **`until()` in tests silently succeeds when the budget expires** — the
  polling helper returns `void` regardless of whether the predicate ever held;
  correctness currently rides on the `expect(...)` after each `until()` call.
  Returning the predicate's final value (or failing) would make the helper
  honest and the tests self-asserting.
- **`deploy.md`/`store.md`/`worker.md` already exist in `docs/refactor/`** —
  this report joins them; the suggested execution order below is what an
  implementer should follow.

## Suggested execution order

1. **`isSocketMessage` + the client's silent decode drop** (Critical 1, 3;
   Type Safety 1) — one commit: honest predicate, error event on the client's
   inbound decode failure, updated tests (a Blob now either rejects up front or
   surfaces as an error event, matching the server).
2. **`Effect.runSync` → `Schema.decodeUnknownSync`** (Critical 2) — mechanical,
   two sites, zero behavior change.
3. **`runConnection` listener lifecycle** (Critical 4) — acquireRelease around
   the three registrations, plus the `wireSocket` helper in `client.ts`
   (Effect Migration 2) if it lands in the same pass.
4. **`let run;` → ternary + `broadcast` concurrency** (Critical 5, Structural 7)
   — two-line changes, do together.
5. **`client.ts` split** (Structural 1) + **derive-or-check `WireClientApi`
   against `COMMANDS`** (Structural 2) — the cohesive change; do after the
   mechanical pass so the registry is stable while it moves.
6. **Duplication removals** (Structural 3–5, 6): `ThreadState` reuse,
   `payload.ts` or header note, one `tagged` alias, fixture `notServed` helper,
   `messageOf` import in the worker (worker's own package).
7. **Constants + version note + `connectRef` guard + `until()`** (Minor) —
   last, smallest.

Do not touch: the `Context.Service { make }` shape (`WireClient.make` /
`WireServer.make` are house style per `style.md`), the `opaque` ADR 0005 seam
itself (pi's types must stay unvalidated on the wire), the `COMMANDS` registry
design, the fixture's isolation decision, or the tests' `runPromise` usage —
all are correct and deliberate.
