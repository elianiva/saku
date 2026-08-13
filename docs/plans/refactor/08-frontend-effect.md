# Plan — 08 · Frontend: Effect config, exhaustive event fold, schema projections

Status: **planned** — parallel plan 08 of the refactor pass (see `README.md`).
The frontend has no test suite (`vitest --passWithNoTests`); proof is
`pnpm --filter @saku/frontend typecheck` + `pnpm --filter @saku/frontend build` +
driving the app in the browser (`pnpm dev`, connect to a local daemon).

## Owned files

Everything under `packages/frontend/src/`:
`config.ts`, `wire.ts`, `commands.ts`, `update.ts`, `subscriptions.ts`, `message.ts`,
`model.ts`, `format.ts`, `thread-pane.ts`, `rail.ts`, `view.ts` (+ new
`projection.ts`). `init.ts`/`main.ts`/`entry.ts` only if a signature forces it
(it shouldn't).

## Problem

1. **Promise outside the seam** (review P1-4): `config.ts` is hand-rolled
   `async`/fetch/try-catch with `JSON.parse` casts; `wire.ts:22` wraps it with
   `Effect.promise(resolveConfig)`.
2. **Silent default** (review P3-8, frontend half): `update.ts` `foldWireEvent` is a
   `switch (event.type)` whose `default: [model, none]` swallows new pi event types
   forever. Exhaustive Match forces a decision per tag.
3. **Casts + unknown-poking** (review P4-14): `event as SessionWireEvent` in
   `update.ts`; `format.ts` narrows pi shapes through `EntryLike`/`MessageLike`/
   `Block` all-optional-unknown interfaces with `as unknown as` casts (~150 lines of
   defensive poking). ADR 0005 keeps pi's types opaque _on the wire_ — correct — but
   the console's own rendering vocabulary should be a local Schema projection
   decoded at the boundaries.
4. **Catch-alls** (review P6-26): every command ends `.pipe(Effect.catch((error) =>
Effect.succeed(XFailed({ message: messageOf(error) }))))` — `WireError` is the
   only error; `catchTag` is precise.

## Design — `projection.ts` (new)

The console's rendering vocabulary, schema-typed, decoded ONLY in the console
(never in `@saku/wire` — ADR 0005). Field lists are exactly what `format.ts` reads
today:

```ts
const ContentBlock = Schema.Struct({
  type: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  thinking: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  arguments: Schema.optional(Schema.Unknown),
});

export const MessageProjection = Schema.Struct({
  role: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Union([Schema.String, Schema.Array(ContentBlock)])),
  toolCallId: Schema.optional(Schema.String),
  toolName: Schema.optional(Schema.String),
  isError: Schema.optional(Schema.Boolean),
  stopReason: Schema.optional(Schema.String),
  errorMessage: Schema.optional(Schema.String),
});

export const EntryProjection = Schema.Struct({
  id: Schema.optional(Schema.String),
  seq: Schema.optional(Schema.Number),
  type: Schema.optional(Schema.String),
  message: Schema.optional(MessageProjection),
  provider: Schema.optional(Schema.String),
  modelId: Schema.optional(Schema.String),
  thinkingLevel: Schema.optional(Schema.String),
  activeToolNames: Schema.optional(Schema.Unknown),
  summary: Schema.optional(Schema.Unknown),
});
```

Optional fields on purpose: pi's entries vary wildly by `type`; the console renders
what is present. `Schema.decodeUnknownOption(EntryProjection)` at the boundaries.

**Event projection** (for `foldWireEvent`): the wire's `SessionWireEvent` is a TS
type, not a Schema. Decode in two steps at the subscription boundary:

```ts
const EventTag = Schema.Struct({ type: Schema.String });

export const SessionEventProjection = Schema.Union([
  Schema.TaggedStruct("entry_appended", { entry: EntryProjection }),
  Schema.TaggedStruct("message_start", { message: MessageProjection }),
  Schema.TaggedStruct("message_end", { message: MessageProjection }),
  Schema.TaggedStruct("message_update", { message: MessageProjection }),
  Schema.TaggedStruct("tool_execution_start", { toolCallId: Schema.String, toolName: Schema.String }),
  Schema.TaggedStruct("tool_execution_update", { toolCallId: Schema.String, partialResult: Schema.Unknown }),
  Schema.TaggedStruct("tool_execution_end", { toolCallId: Schema.String, isError: Schema.Boolean, result: Schema.Unknown }),
  Schema.TaggedStruct("settled", {}),
  Schema.TaggedStruct("compaction_start", { reason: Schema.Literals(["manual", "threshold", "overflow"]) }),
  Schema.TaggedStruct("compaction_end", { reason: Schema.Literals(["manual", "threshold", "overflow"]), result: Schema.optional(Schema.Unknown), aborted: Schema.Boolean, errorMessage: Schema.optional(Schema.String) }),
  Schema.TaggedStruct("unhandled", { event: Schema.Unknown }),  // the explicit long tail
]);

export const decodeSessionEvent = (event: unknown): SessionEventProjection =>
  Schema.decodeUnknownSync(EventTag)(event).pipe(Option.match(…)) // tag-driven routing:
  // known tag + typed decode succeeds → typed variant; anything else → unhandled(event).
```

`unhandled` is the honest replacement for the silent `default`: known tags are
typed, unknown pi events degrade to a named no-op branch instead of being cast.

## Steps

### 1. `config.ts` + `wire.ts` (kill the Promise)

```ts
const BootstrapSchema = Schema.Struct({ url: Schema.String, token: Schema.String });

export const fetchBootstrap: Effect.Effect<Option.Option<SakuConfig>, never> = Effect.tryPromise({
  try: () =>
    fetch("/__saku").then((response) =>
      response.ok ? (response.json() as Promise<unknown>) : null,
    ),
  catch: () => null,
}).pipe(
  Effect.flatMap((parsed) =>
    parsed === null
      ? Effect.succeed(Option.none())
      : Effect.sync(() => Schema.decodeUnknownOption(BootstrapSchema)(parsed)),
  ),
);

export const resolveConfig: Effect.Effect<SakuConfig, never> = Effect.gen(function* () {
  const bootstrap = yield* fetchBootstrap;
  if (Option.isSome(bootstrap)) return bootstrap.value;
  const saved = readSavedConfig(); // sync localStorage read; keep the try/catch here
  if (saved !== null) return saved;
  return defaultConfig();
});
```

`readSavedConfig`: keep localStorage + try/catch (browser sync API; the decode can
use `Schema.decodeUnknownOption(BootstrapSchema)(JSON.parse(raw))` inside the try).
`wire.ts`: `const config = yield* resolveConfig;` (drop `Effect.promise`). No
`async` remains in `config.ts`.

### 2. `commands.ts` (catchTag + drop local `messageOf`)

Every `.pipe(Effect.catch((error) => …))` → `.pipe(Effect.catchTag("WireError",
(error) => Effect.succeed(XFailed({ message: error.message }))))`. All 8 command
effects only fail with `WireError` (verify each body — `WireConnectCmd`,
`ListThreadsCmd`, `QuickStartCmd`, `DeleteThreadCmd`, `LoadTrailCmd`, `PromptCmd`
fail with WireError; `AbortCmd` already catches to `AbortDone` — `catchTag`
there too). Delete the local `messageOf` (use `error.message`). `ScrollTrailCmd`
is `Effect.sync` — untouched.

### 3. `subscriptions.ts` + `message.ts` (decode at the boundary)

- `message.ts`: `WireEvent = Message.m("WireEvent", { threadId: S.String, event:
SessionEventProjection })`; `TrailLoaded.entries: S.Array(EntryProjection)`.
- `subscriptions.ts`: the `client.on("event", …)` callback decodes:
  `Queue.offerUnsafe(queue, WireEvent({ threadId: payload.threadId, event:
decodeSessionEvent(payload.event) }))`. `client.on("error")` — the payload is
  `{message}` already — unchanged. Import `decodeSessionEvent` from `projection.ts`.
- `LoadTrailCmd` in `commands.ts`: decode entries once here —
  `entries: result.entries.map((entry) => decodeEntry(entry))` where `decodeEntry =
Schema.decodeUnknownOption(EntryProjection)` — hmm, entries that fail decode
  become `None`; the trail renders what it can. Decide: `Array.filterMap` to
  `Option.some` (drop undecodable) or keep `Unknown`? The projection is fully
  optional-fielded, so decode never fails in practice (any object decodes). Use
  `Schema.decodeUnknownSync` with `Effect.try`/`Result.try` fallback to `undefined`
  and filter — specify: undecodable entry → dropped with a console.warn (bounded,
  never crashes the trail). `model.ts`'s `Trail` schema: `entries:
S.Array(EntryProjection)`.

### 4. `update.ts` (exhaustive fold, no casts)

`foldWireEvent` → `M.value(event).pipe(M.withReturnType<UpdateReturn>(),
M.tagsExhaustive({ … }))` with the 10 typed tags mapping to the current bodies
(mechanical: `entry_appended` → `foldEntryAppended(model, event.entry)` — now typed;
`message_start/message_end` → the `messageText(messageOf(event.message))` body; etc.)
plus `unhandled: () => [model, none]`. The `event as SessionWireEvent` cast in
`WireEvent: ({threadId, event}) => threadId === model.active ? foldWireEvent(model,
event) : [model, none]` disappears (event is typed). `foldEntryAppended(model,
entry: EntryProjection)` — update its signature; the `asString(entryOf(entry).id)`
calls become direct field reads.

### 5. `format.ts` (projection reads; delete the poking)

Every helper's input becomes `MessageProjection` / `EntryProjection`:

- `asString` stays (defensive string cast of optional fields).
- `entryOf`/`messageOf`/`isRecord` **deleted** — callers get typed values.
- `messageRole/messageError/messageText/messageThinking/messageToolCalls/
messageToolResult/argsPreview/tail/stringifyLive/summaryLine` operate on the
  projections: `block.type === "text"` checks stay (fields are optional strings),
  the `as unknown as Block` casts go.
- `try/catch` in `argsPreview`/`stringifyLive` stays (JSON.stringify of unknown
  payloads — genuinely throwy).

### 6. Views

`thread-pane.ts`, `rail.ts`, `view.ts`: mechanical — they call the `format.ts`
helpers with entries/messages that are now `EntryProjection`/`MessageProjection`;
signatures already line up since the helpers keep their names. Any place that did
`entryOf(entry)` manually gets `entry` directly. `model.ts`'s `LiveTool` and the
live-region folding (`foldWireEvent`'s `tool_execution_*` bodies) are unchanged
semantics.

## Order within the plan

`projection.ts` → `config.ts`/`wire.ts` → `commands.ts` → `message.ts`/`model.ts`
→ `subscriptions.ts` → `update.ts` → `format.ts` → views. Typecheck continuously.

## References

- TEA + Match: lutra `packages/frontend/src/editor/update.ts:218`,
  `root/update.ts:102`; foldkit `packages/typing-game/client/src/page/home/update/update.ts`.
- Boundary decode: foldkit `packages/typing-game/client/src/rpc.ts` +
  `packages/foldkit/src/http/http.ts` (`S.decodeUnknownEffect` on the response),
  lutra `packages/frontend/src/root/subscriptions.ts` (decode inside the stream).
- `Effect.tryPromise` fetch: lutra `packages/frontend/src/editor/command.ts:98`
  (`{ try, catch }` → tagged error or fallback).
- catchTag: lutra `packages/frontend/src/editor/command.ts:306-316`
  (`Effect.catchTag('GpuError', …)`).
- Projection discipline: saku's own `packages/wire/src/session.ts` header (ADR 0005
  rationale) — the projection lives in the console, never in the wire package.

## Verification

```sh
pnpm --filter @saku/frontend typecheck
pnpm --filter @saku/frontend build
```

Then drive it: `pnpm dev`, run a local daemon (`node packages/cli/src/entry.ts
daemon start`), verify: quick-start a thread, watch the live run (streaming message,
tool calls, settled), compact once, delete a thread. The foldkit dev overlay flags
bad messages/models — nothing should appear.

## Definition of done

- No `async`/`Promise` in `config.ts`/`wire.ts`; no `Effect.promise` in the frontend.
- `foldWireEvent` is `M.tagsExhaustive`; `unhandled` is the only fallback, and it is
  an explicit named tag.
- No `as SessionWireEvent` cast anywhere; no `EntryLike`/`MessageLike`/`Block`
  interfaces; `format.ts` operates on projections.
- All commands use `catchTag("WireError", …)`.
- Build green; manual browser pass shows identical behavior.
