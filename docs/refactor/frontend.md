# Frontend Refactor Report

Scouted by a codebase scout (no edits made). Grounded in a full read of every
file in `packages/frontend/src/` (10,218 lines incl. tests), the reference app
`~/Development/personal/apps/lutra/packages/frontend/`, and the Effect library
source in `~/Development/repos/effect/packages/effect/src/`.

---

## Overview

`@saku/frontend` is a foldkit TEA console for the saku hub/daemon: a **rail**
(thread registry, projects window, pi-session adoption, add-project picker) and
a **thread pane** (entry trail, live streaming run, Lexical composer) behind
`Got*Message` boundaries at the root, plus a `conn` machine for the wire
lifecycle. The wire connection is a single `Context.Service` (`Wire`) built in
`WireLive` (wire.ts), fed by config resolution (config.ts) and drained by root
subscriptions.

**Current state: the Effect discipline is already strong.** Services
(`Context.Service`), `Layer.effect`, schema-first messages and models
(`Schema as S` everywhere), exhaustive `Match`, `AsyncData`, `Stream`/`PubSub`
subscriptions, `Effect.gen` command bodies, `Effect.fn` for traced functions,
`Data.TaggedEnum` for bridge events. The wire client itself is an
effect-machine actor in `@saku/wire`. Tests are property-based with fast-check,
pinned against independent oracles — unusually good.

The problems are **size, one module-level singleton, one hard-cast, and a
couple of de-duplication opportunities** — not broken abstractions. Nothing
here is blocking; everything below makes the package materially simpler.

### What the reference (lutra) does better

- lutra decomposes the editor view into `view.ts` + `top-bar.ts` +
  `tool-panel.ts` + `layer-drawer.ts` + `canvas-stage.ts` + `export-dialog.ts`.
  saku's `thread/view.ts` is one 1,202-line file.
- lutra keeps all mutable service state in **layer-scoped `Ref`s, no module
  globals** ("All mutable state lives in Refs scoped to this Layer instance" —
  gpu/backend.ts). saku's composer keeps a module-level `Map` singleton.
- lutra gates every resource behind a `Layer.merge` at `makeApplication`.
  saku's single `WireLive` resource is a fine simplification.

---

## Critical Issues

### 1. `thread/view.ts` is 1,202 lines — the only file over 1,000

Five distinct surfaces in one file:

| Region | Lines | Surface |
|---|---|---|
| 149–591 | ~440 | trail + live region rendering (`renderEntry`, `renderMessageEntry`, `toolCallRow`, `thinkingBlock`, `liveRegion`) |
| 593–950 | ~360 | model picker (`modelBadge`, `modelPickerPanel`, `contextBadge`, `usagePanel`) |
| 950–1135 | ~185 | composer menu panel, editor, box, toolbar |
| rest | ~120 | header, welcome, `view` |

**Move:** extract `thread/trail.ts` (trail + live region, ~440 lines) and
`thread/composer/view.ts` (model picker + usage panel + composer menu/box,
~550 lines) — mirroring lutra's view decomposition. `thread/view.ts` keeps the
header, the welcome, and the assembly. Pure renames; no behavior change.

### 2. `rail/view.ts` is 777 lines — trending the same way

- The **picker dialog** is ~270 lines (296–567: `pickerHeader` →
  `pickerDialog`). Extract `rail/picker.ts`.
- The **projects window** is ~180 lines (568–750: `piSessionRow` →
  `projectsSection`). Extract `rail/projects.ts` if the picker split is
  already happening.

### 3. The composer's module-level `editors` singleton bypasses the Service discipline

`thread/composer.ts` keeps a `Map<ComposerKind, LexicalEditor>` **at module
scope**; the four `*ComposerCmd` commands reach into it directly. The Mount's
acquire/release register/unregister into the same global. This is the one piece
of the app where state crossing the command boundary is invisible to the
runtime and unreplayable in DevTools (a command mutates an editor that may not
exist; a stale editor for a swapped route is dropped by an identity check).

The fix is cheap: these commands are already used in positions typed
`Command<ThreadMessage, never, Wire>[]` (thread/update.ts), so widening their
`R` to `Wire` is free. Move the registry into the `Wire` service (the app's one
resource) as a layer-scoped `Ref<Map<...>>`, and the commands resolve it via
`yield* Wire` like every other command. The Mount registers through the
service. If the foldkit `Mount` API can't resolve services (its effects are
`R = never`), register via the existing `Wire` layer instance — the layer owns
the Ref, the Mount mutates it through an injected closure.

---

## Structural Improvements (code judo)

### 4. Collapse the 20 near-identical wire commands

`rail/command.ts` repeats this shape 12 times, `thread/command.ts` 8 times:

```ts
execute: Effect.gen(function* () {
  const { client } = yield* Wire
  const x = yield* client.foo(args)
  return FooLanded({ x })
}).pipe(Effect.catchTag("WireError", onFooError))
```

One generic helper kills ~60 lines:

```ts
const wire = <A, E extends WireError>(
  op: (client: WireClientApi) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const { client } = yield* Wire
    return yield* op(client)
  })
```

…leaving each command as `execute: wire((c) => c.listThreads()).pipe(
Effect.catchTag("WireError", onListThreadsError))`. The `on*Error` handlers are
already hoisted — extend that pattern to the bodies. Keep the per-command
`messages` arrays as-is.

### 5. Unify `delegateToRail` / `delegateToThread` in root/update.ts

Identical shape, differing only in the slice update fn, the `Got*Message`
wrapper, and the out-message → navigation mapping:

```ts
const delegate = <Msg, Out>(
  model: Model,
  run: (slice: ..., msg: Msg) => readonly [..., Option.Option<Out>],
  wrap: (m: Msg) => RootMessage,
  navigate: (out: Out) => Commands,
): UpdateReturn => ...
```

The rail maps `OpenedThread → /thread/:id`, `DeletedThread → "/" when pinned`;
the thread maps `OpenedThread → /thread/:id`, `NewThreadRequested → "/"`. Those
two navigation functions become the only per-submodel differences (~35 lines
removed). This is optional — 2 call sites — but it removes the only duplicated
block in the root.

### 6. Duplicate exported names in rail/model.ts

```ts
export const ThreadList = AsyncData.Schema(...)
export const threadList = ThreadList   // same value, second name
```

Same for `Projects`/`projects`, `ProjectSessions`/`projectSessions`,
`BrowseEntries`/`browseEntries`. Pick one name per AsyncData (the lowercase is
used in update.ts, the uppercase in tests) — dual names for one value invite
drift.

### 7. `resetViewFields` triplication (thread/update.ts)

`resetViewFields` (route change), the `applyComposerSuggestion` "model" arm,
and `ModelPickerRequested` each set the same
`composerMenu/modelPicker/pickerActive/pickerQuery/usageOpen` reset inline.
Extract one `openModelPicker` evo-fields object shared by all three.

### 8. Minor

- `applyComposerSuggestion`'s `default` arm in the exhaustive `switch` over
  `ComposerSuggestionAction` is dead weight — the union is closed; use an
  exhaustive match.
- Every update arm returns `[evo(...), none, Option.none()]`; a `pure(next)`
  alias would cut noise in rail/update.ts and thread/update.ts. Stylistic.
- `thread/update.ts` ack arms (`ComposerCleared`, `ComposerEditableChanged`,
  `ComposerTriggerRemoved`, `ComposerSuggestionInserted`, `AbortDone`,
  `CompactionFinished`, `StateFailed`) are intentional no-ops for DevTools
  visibility — keep them, but note them in one doc comment so nobody "cleans"
  them up.

---

## Effect Migration (Promise → Effect)

There are **exactly two** Promise-based spots in `src/` (tests excluded).

### 9. `config.ts` — the `fetch("/__saku")` bootstrap

The only raw `fetch` in the package, already inside `Effect.tryPromise`. The
shape is the problem, not the wrapper:

```ts
Effect.tryPromise({ catch: () => null, try: async () => {...} })
  .pipe(Effect.orElseSucceed(() => null), Effect.flatMap(...))
```

`Effect.orElseSucceed` swallows **defects too**, not just the caught failure —
belt-and-braces that hides real bugs. Restructure as:

```ts
export const fetchBootstrap = Effect.gen(function* () {
  const response = yield* Effect.tryPromise({
    catch: () => null,             // network failure = no bootstrap
    try: () => fetch("/__saku"),
  })
  if (response === null || !response.ok) return Option.none()
  const parsed = yield* Effect.try(() => response.json())
  ...
})
```

with one early-return per fallback instead of nested `Option.getOrNull` +
`Effect.sync`. Also note `@effect/platform-browser` (a declared dependency,
currently **unused** anywhere in src) ships `HttpClient` — a typed, abortable
fetch would remove the `tryPromise` and the `SAFETY` casts around `response.json()`.

### 10. `markdown.ts` — the `markdownReady` async IIFE

```ts
export const markdownReady = (async () => {
  try { await md4xInit(); ready = true } catch (error) { void error }
})()
```

A floating module-level promise with a `try/catch` that swallows the error
(the fallback render masks it forever). `Effect.promise` + `Effect.cached`
(Effect.ts Caching section) models "init once" properly:

```ts
const initMd4x = Effect.cached(Effect.promise(() => md4xInit().pipe(
  Effect.catchAll((e) => Effect.logWarning("md4x init failed; using plain fallback", e)),
)))
```

and drive it once at boot (main.ts or a Layer) instead of at module load.
`markdownBody` stays a sync pure function — the readiness flag is fine, only
the floating promise and silent swallow go away.

### 11. `wire.ts` connect re-resolution — intentional, but worth a note

`connect()` re-resolves the bootstrap on every call (a `/__saku` fetch each
retry tick). This is deliberate — the daemon-restart detection depends on
re-reading the URL file — so **do not** memoize it outright. If the fetch ever
becomes costly, `Effect.cachedWithTTL` with a short TTL is the lighter option;
document the choice either way.

---

## Type Safety Improvements

### 12. Remove the `as readonly Command.Command<...>[]` SAFETY cast

root/update.ts `Connected` arm:

```ts
[
  LoadTrailCmd({ id: model.route.id }),
  LoadStateCmd({ id: model.route.id }),
] as readonly Command.Command<ThreadMsg.ThreadMessage, never, Wire>[]
```

The comment admits the annotation exists to satisfy `mapMessages`' callback
typing. This is a latent break: a new command in that list silently widens the
cast. A `wrapThread(cmds: ThreadCommands): Commands` helper (typed through the
shared `Commands` alias) makes it a real check instead of an escape hatch.

### 13. `fetchBootstrap`'s explicit return annotation

`export const fetchBootstrap: Effect.Effect<Option.Option<ResolvedConfig>> = ...`
— inference works here; drop it per AGENTS.md (no return annotations).

### 14. Narrow `WireApi.client`

`wire.ts` exposes `client: WireClientApi` — the full surface including
`disconnect`, `on`, `start`. Commands only need the request methods. A
`Pick`-narrowed type (or a `Commands`-only interface) turns the service
boundary into a real one: nothing outside wire.ts can close the socket or
re-wire listeners.

### 15. Deliberate non-issues (don't "fix" these)

- `presentation.ts` hand-rolled `Json` narrowing for usage payloads — a
  conscious ADR 0005 choice ("decoded in presentation.ts, never re-schema'd");
  tested. Keep.
- `tools.ts`/`format.ts` defensive `asString` casts over optional projection
  fields — the projection is intentionally all-optional (pi's shapes vary).
  Keep.
- `scroller.ts` and `wire.ts` use `Stream.callback`/`Stream.fromPubSub`
  correctly with `acquireRelease` lifecycles — reference-quality Effect usage.

---

## Minor Cleanups

- **`config.ts`**: `readSavedConfig` and `fetchBootstrap` share `BootstrapSchema`
  — good; keep shared. The `SAFETY` comments around `response.json()` /
  `JSON.parse` are fine once the decode is the sole gate.
- **`icon.ts`**: 124 lines, pure data — fine as-is.
- **`thread/composer.ts`**: `FileMentionNode` and the trigger-selection logic
  are well-isolated; the singleton (item 3) is the only change needed here.
- **`scroller.ts`**: `id="trail"` in `trailArea` — a global id on a single-
  instance pane; fine today, flag if a second pane ever mounts.
- **Tests** (4,300 lines): property style is the house standard and good.
  `rail/update.test.ts` and `thread/update.test.ts` at ~515 lines each are the
  largest; no action needed.
- **`markdown.ts`**: 478 lines, self-contained renderer table — acceptable;
  if it grows, split the tag renderers into a data table module.
- **`thread/update.ts` `SendFailed`** uses `model.info?.state !== "working"`
  inline while `ThreadChanged`/`StateLoaded` compute the same "editable" flag —
  one `editable(model)` derivation would unify the three.

---

## Priority order (if doing it in one pass)

1. Items 1–2 (view decomposition — pure moves, biggest readability win).
2. Item 4 (command boilerplate collapse — largest line-count reduction per
   change).
3. Item 12 (remove the hard cast) + item 13 (drop the annotation) — 10 minutes,
   removes the two type-safety smells.
4. Item 3 (composer registry into the Wire layer) — the one behavioral change;
   verify the mount lifecycle in DevTools after.
5. Items 5–7, 9–10, 14 — polish.
