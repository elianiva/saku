# Plan — 04 · Hub cleanup: error model, orchestration, equivalence

Status: **planned** — parallel plan 04 of the refactor pass (see `README.md`).

## Owned files

- `packages/hub/src/hub-error.ts`
- `packages/hub/src/hub.ts`
- `packages/hub/src/box.ts`
- `packages/hub/src/provisioner.ts`
- `packages/hub/src/server.ts`
- Tests: `packages/hub/test/hub.test.ts`, `packages/hub/test/idle-stop.test.ts`, `packages/hub/test/provisioner.test.ts`, `packages/hub/test/mock-worker.ts`

`hub/src/registry.ts` + `hub/src/skills.ts` belong to plan 01 and construct `HubError`
too — that is why `kind` is **optional** here (see README "error discriminants are
staged"). `hub/src/wire-core.ts` belongs to plan 02 — do not touch it.

## Problem

1. `HubError`/`BoxError` are `{message, cause}` catch-alls — tagged in name only
   (review P2-5). `WireError` (`code` literals) is the house model.
2. `hub.ts` `listThreads` serializes independent registry reads in a for-loop
   (review P3-10).
3. `hub.ts` `applyReport` detects change with `JSON.stringify(before) !==
   JSON.stringify(after)` — stringify as equivalence (review P6-22).
4. `hub.ts` `notify` contains listener failures with try/catch; the wire client's
   `emit` uses `Result.try` — one concept, two implementations (review P6-20).
5. `box.ts` `pollUntilReady` polls via self-recursion + `Date.now()` deadline
   instead of `Effect.retry` + `Schedule` + `Clock` (review P6-17).
6. `provisioner.ts`: mid-file import (line ~40, `import { HubError }` after
   `randomToken`); `probeDaemon`'s `catch: (error) => error as Error` cast without
   instanceof (review P6-23).

## Design

### `hub-error.ts`

```ts
export class HubError extends Schema.TaggedError<HubError>()("HubError", {
  kind: Schema.optional(Schema.Literals(["registry", "worker", "provisioner", "resolution", "skills", "command"])),
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export const makeHubError = (kind: HubError["kind"], message: string, cause?: unknown): HubError => ...
```

Optional on purpose (staged migration — plan 01/02 construction sites must keep
compiling). Migrate every `new HubError({…})` in **this plan's files** to
`makeHubError(kind, …)`: `registry` (thread lookups/record failures surfaced as
hub errors), `worker` (workerRef forwarding/create failures), `provisioner` (env
ensure/release), `resolution` (unknown/ambiguous thread), `skills` (unknown skill),
`command` (validation like empty name, missing threadId). Update
`mock-worker.ts`'s `HubError` constructions to match.

### `hub.ts`

- `listThreads` (line ~300): `Effect.forEach(records, (record) => infoOf(record.id), { concurrency: "unbounded" })`.
- `applyReport` (line ~250): `const threadInfoEq = Schema.equivalence(ThreadInfo)` at
  module scope; replace the stringify comparison with `!threadInfoEq(before.value, after.value)`.
- `notify` (line ~215): replace try/catch with `Result.try(() => listener(event))` +
  warn on failure — mirror `emit` in `packages/wire/src/client.ts:200` (read it; it
  is the reference, not owned by another plan so reading is fine).
- Merge the two `effect` import statements into one.
- Leave `READ_ONLY_COMMANDS`/`isReadOnly` as-is: the hub's set is the **env gate**
  (ADR 0004), a different concern from the shared dispatch plan 02 dedupes.

### `box.ts`

`pollUntilReady` → the lutra pattern (`packages/frontend/src/offline/fill.ts:236`):

```ts
export const pollUntilReady = (api, boxId, options = {}) => {
  const intervalMs = options.intervalMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const attempt = Effect.gen(function* () {
    const box = yield* api.getBox(boxId);
    if (box.status === "ready" || box.status === "idle") return box;
    return yield* Effect.fail(
      new BoxError({ message: `box ${boxId} not ready (status ${box.status})` }),
    );
  });
  return attempt.pipe(
    Effect.retry({
      schedule: Schedule.spaced(`${intervalMs} millis`).pipe(Schedule.compose(Schedule.recurs(Math.ceil(timeoutMs / intervalMs)))),
      // final error: annotate with the timeout message like today
    }),
  );
};
```

Exact schedule math: today's behavior is "poll every `intervalMs`, fail with the
timeout message when `Date.now() > deadline`". Closest idiomatic equivalent:
`Effect.retry` with `Schedule.spaced(intervalMs)` + `Schedule.upTo(timeoutMs)` (total
duration), and a final `Effect.mapError`/`catchAll` that rewrites the last failure to
the current timeout message (`box X not ready after Nms (status S)` — keep the text).
Keep the per-poll `log` option behavior.

### `provisioner.ts`

- Move the `HubError` import up into the import block (house style).
- `probeDaemon`: replace `catch: (error) => error as Error` with the instanceof
  passthrough idiom (lutra `luts/store.ts:46`): `catch: (cause) => cause instanceof
  Error ? cause : new Error(String(cause))`, or better: let the tryPromise error be
  `unknown` and let the `Effect.result` failure arm message it via `messageOf`
  (imported from `hub-error.ts` — it already exports it).

### `server.ts`

Read-only: the `resume(Effect.fail(new Error("no listening address")))` (~line 102)
is a startup defect — leave it (it is the process's fatal path), but note in the
header comment that startup failures are defects by design, matching the
`makeSakuDaemon` contract. No other edits.

## Steps

1. `hub-error.ts`: add optional `kind` + `makeHubError`; update the doc comment.
2. `hub.ts`: the three changes above (forEach, equivalence, Result.try) + import merge.
3. `box.ts`: Schedule-based poll.
4. `provisioner.ts`: import placement + catch passthrough.
5. `mock-worker.ts`: switch its `HubError` constructions to `makeHubError` if they
   assert on error identity (check the tests first — if tests match on message only,
   kind is optional to add; keep the file compiling).
6. Run the hub suite; `idle-stop.test.ts` and `provisioner.test.ts` must pass
   unchanged (behavior-preserving).

## References

- `Result.try` listener containment: `packages/wire/src/client.ts` `emit` (~line 200).
- Equivalence: `Schema.equivalence` in effect 4 beta (foldkit uses
  `Stream.changesWith(equivalence)` the same way — `packages/foldkit/src/runtime/runtime.ts`).
- Schedule retry: lutra `packages/frontend/src/offline/fill.ts:236`
  (`Effect.retry({ times: 5, schedule: Schedule.exponential(...) })`).
- Error discriminants: `packages/wire/src/client.ts:80` (`WireError`), opencode
  `packages/core/src/git.ts` (`Git.OperationError` with `operation` literals).

## Verification

```sh
pnpm --filter @saku/hub typecheck && pnpm --filter @saku/hub test
```

## Definition of done

- Every `HubError` construction in the owned files passes a `kind`; the class doc
  explains the staged-optional plan (required after all plans merge).
- `listThreads` uses `Effect.forEach` with `{ concurrency: "unbounded" }`.
- `applyReport` uses a Schema Equivalence; no `JSON.stringify` comparison.
- `notify` uses `Result.try`; `pollUntilReady` uses `Effect.retry` + `Schedule`.
- Hub suite green; no files outside the owned list edited.
