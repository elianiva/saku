# Plan — 09 · Deploy tidy: hub-do push decoding + Match, effect memoization

Status: **planned** — parallel plan 09 of the refactor pass (see `README.md`).
Smallest plan by design — the DO classes are the platform boundary, and plan 02
already owns `thread-do.ts`/`rpc.ts`.

## Owned files

- `packages/deploy/src/hub-do.ts`
- `packages/deploy/src/static-provisioner.ts`
- `packages/deploy/src/worker.ts`

## Problem

1. `hub-do.ts` `handlePush` (~line 185) does `push = (await request.json()) as HubPush`
   inside try/catch, then a `switch (push.type)` — saku's own push contract,
   unvalidated + non-exhaustive (review P4-11 / P3-8, DO-boundary instances).
2. `hubShape()` (~line 95) memoizes through a `Promise<HubShape>` cache with
   `Effect.runPromise` inside — fine at a fetch boundary, but the memoization idiom
   is Effect's (`Effect.cached`), and the current mix of `await` + `Effect.runSync`
   in `wireCore()` is awkward (review P1-4's last bullet).
3. `static-provisioner.ts` and `worker.ts` were not reviewed in depth — read them
   and apply the same idioms only if a clear pattern exists (see "scope guard").

## Design

### `HubPush` schema + Match

`HubPush` is defined in `rpc.ts` (plan 02's file — do not move it). In `hub-do.ts`
define the validation locally against the exported type:

```ts
const HubPushSchema = Schema.Union([
  Schema.TaggedStruct("report", { threadId: Schema.String, report: Schema.Struct({
    state: Schema.optional(…),  // ThreadState literals from @saku/wire
    sessionId: Schema.optional(Schema.Union([Schema.Null, Schema.String])),
    name: Schema.optional(Schema.String),
    tailSeq: Schema.optional(Schema.Number),
  }) }),
  Schema.TaggedStruct("sessionEvent", { threadId: Schema.String, event: Schema.Unknown, tailSeq: Schema.Number }),
  Schema.TaggedStruct("idleStopFired", { threadId: Schema.String }),
]);
```

(`WorkerReport`'s fields: `state` is `ThreadState` — import the literal schemas from
`@saku/wire` — `sessionId: string | null | undefined`, `name`, `tailSeq`.) Then:

```ts
private async handlePush(request: Request): Promise<Response> {
  const parsed = await Effect.runPromise(
    Effect.tryPromise({ try: () => request.json() as Promise<unknown>, catch: () => undefined })
      .pipe(Effect.flatMap((body) => Effect.sync(() => Schema.decodeUnknownOption(HubPushSchema)(body)))),
  );
  if (Option.isNone(parsed)) return jsonError("malformed push");
  const push = parsed.value;
  return Match.value(push).pipe(
    Match.tags({
      report: ({ threadId, report }) => { hub.events.report(threadId, report); return jsonOk({}); },
      sessionEvent: ({ threadId, event, tailSeq }) => { hub.events.sessionEvent(threadId, event, tailSeq); return jsonOk({}); },
      idleStopFired: ({ threadId }) => Effect.runPromise(hub.idleStopFired(threadId))
        .then(() => jsonOk({}))
        .catch((error: unknown) => jsonError(String(error))),
    }),
  );
}
```

(Adjust to a plain `Match.value(push).pipe(Match.tagsExhaustive(…))` — the three
arms above are exhaustive by construction, no `default` needed. Keep the
`hub.events.*` fire-and-forget semantics exactly as today.)

### `hubShape()` memoization

Keep the promise cache (the DO's `fetch`/`alarm` entry points ARE promise-shaped —
that is the platform seam, like the CLI's `Effect.runPromise(main())`), but make the
inner construction a single named Effect and note the seam in the comment:

```ts
private buildHubShape(): Effect.Effect<HubShape, never> { …the current Effect.gen body… }
private hubShape(): Promise<HubShape> {
  if (this.hubPromise === undefined) {
    this.hubPromise = Effect.runPromise(this.buildHubShape());
  }
  return this.hubPromise;
}
```

`wireCore()`/`relayCore()`: replace `await` + `Effect.runSync` mixing with
`Effect.runSync(makeWireCore(...))` only if `this.hubShape()` isn't needed — it is
needed for the hub. So: make `wireCore()` async as today but document that the
`runSync` is safe because `makeWireCore` performs no blocking async work (its
`Effect.gen` only builds Refs). No structural change required — a comment + keeping
one style. Do not over-engineer this file.

### Scope guard for the other two files

- `static-provisioner.ts` (34 lines): read it. If it is already clean (a configured
  env daemon handle — likely a small Effect-returning function), leave it with at
  most a header-comment touch-up. Do not rewrite for sport.
- `worker.ts` (27 lines): the worker entry — likely `export default { fetch }`
  plumbing. Leave unless it contains one of the review's patterns (cast-decode,
  hand-rolled exhaustiveness); if it does, apply the same fixes and note it in the
  plan status.

## Steps

1. `hub-do.ts`: `HubPushSchema` + decode + Match per design; `buildHubShape` split;
   comment on the promise-cache seam; `wireCore()` comment on `runSync` safety.
2. Read `static-provisioner.ts` + `worker.ts`; apply only pattern-matching fixes.
3. Deploy suite: `pnpm --filter @saku/deploy typecheck && pnpm --filter @saku/deploy
   test` — the integration test drives the real hub DO through `makeStack`, so the
   push path is exercised.

## References

- DO boundary as seam: `packages/deploy/src/thread-do.ts` header (the DO classes are
  "plain workerd — no alchemy runtime" — the fetch/alarm promise shapes are the
  platform, not ours to change).
- Decode + Match at an RPC boundary: saku's own `packages/hub/src/wire-core.ts`
  `DECODE_COMMAND` hoisted decode + `packages/env/src/daemon.ts` decode-first-frame
  pattern; foldkit `examples/websocket-chat/src/main.ts` (Stream.callback decode).
- `Effect.runPromise` only at the entry edge: opencode
  `packages/opencode/src/effect/run-service.ts`, lutra
  `packages/frontend/src/encode/worker-layer.ts`.
- Schema for union payloads: `packages/wire/src/envelope.ts` (`WireEvent` union) —
  the house pattern for exactly this shape.

## Verification

```sh
pnpm --filter @saku/deploy typecheck && pnpm --filter @saku/deploy test
```

## Definition of done

- `handlePush` decodes with a Schema and dispatches with `Match.tagsExhaustive`; no
  `as HubPush` cast, no `default` arm.
- `hubShape()` construction is a named Effect, run once at the promise seam.
- `static-provisioner.ts`/`worker.ts` either untouched or fixed with a note.
- Deploy suite green; no files outside the owned list edited.
