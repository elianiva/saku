# Plan — 03 · Decompose session-host.ts: files, reply union, error kinds

Status: **planned** — parallel plan 03 of the refactor pass (see `README.md`).

## Owned files

- `packages/worker/src/session-host.ts` (1149 lines → target ≤ ~600)
- `packages/worker/src/session-host-error.ts` (new)
- `packages/worker/src/session-machine.ts` (new)
- `packages/worker/src/agent-events.ts` (new)
- Tests: `packages/worker/test/session-host.test.ts`, `packages/worker/test/remote-host.test.ts`

`SessionHost.create`'s public signature and `SessionHost`'s method surface must stay
**identical** — the hub tests (`in-process-worker.ts`) and `thread-do.ts` (plan 02's
file) call it and cannot be edited by this plan.

## Problem

1. `session-host.ts` crossed 1000 lines (1149). Natural seams exist: the
   effect-machine definition, the host value + creation, and the pi agent-event
   projection are three separate concerns.
2. `HostReply` (~line 120) is a hand-rolled `{ok, message?, result?}` + `okReply`/
   `failReply` — the references model replies as tagged unions (lutra's failure sets,
   foldkit's `Effect.result` + `S.Result`).
3. `SessionHostError` is `{message, cause}` only — every failure site is a fresh
   string; callers can't `catchTag` (review P2-5).
4. The busy-state rejections are 9 near-identical `.on` registrations (3 run commands
   × Working/Compacting/Crashed). `.on` accepts state arrays — 3 registrations do it.

## Design

### File split

- **`session-host-error.ts`**: `SessionHostError` (with the new `kind` field),
  `toSessionHostError`, `messageOf`. Imported by the other three — no cycles.
- **`session-machine.ts`**: `HostState` (`State`), `HostEvent` (`Event` + reply
  schemas), the `HostReply` union, `wireStateOf`, `hostStateOf`, `HostDeps`,
  `startRun`, `safeReply`, `makeHostMachine`, and the machine-specific helpers
  (`applyThinkingLevel`, `applyModel`, `runCommand`, `maybeAutoCompact`,
  `runCompaction`, `maybeAutoTitle`, `entriesFromLog`, `AUTO_TITLE_*` constants).
  Exports `SessionHostState` type + `HostStateV`.
- **`agent-events.ts`**: `handleAgentEvent`, `projectAgentEvent`, `stripUndefined`
  (the durable-append + wire projection seam).
- **`session-host.ts`**: `SessionHostError` re-export, `SessionHost` interface,
  `SessionHostOptions`, `SessionHost.create` (trail recovery, agent construction,
  refs, deps, the value object, `dispose`). Re-export the machine/agent-events types
  `isolate.ts` consumers need.

### `SessionHostError` kinds

`kind: Schema.Literals([...])`, required (all construction sites are in these four
files). Enumerate from the actual `Effect.fail` sites:
`"unknown_model"` (unknown model: X), `"no_auth"` (no API key configured),
`"no_model"` (no model selected), `"compact_prepare"` (prepareCompaction failure),
`"pi_seam"` (`toSessionHostError`'s default), `"command_failed"` (reply failure),
`"branch_busy"` (cannot branch while working), `"unknown_entry"`, `"unknown_thread"`.
Keep `message` + optional `cause`.

### `HostReply` union (replaces `{ok,…}`)

```ts
const ReplyOk = Schema.TaggedStruct("reply_ok", {
  result: Schema.optional(Schema.Unknown), // compact result
  model: Schema.optional(Schema.Union([Schema.Null, WireModelInfo])),
  level: Schema.optional(ThinkingLevelSchema),
});
const ReplyFailed = Schema.TaggedStruct("reply_failed", { message: Schema.String });
const HostReply = Schema.Union([ReplyOk, ReplyFailed]);
```

- `okReply(extra)` → `ReplyOk.make(extra)`; `failReply(message)` → `ReplyFailed.make({ message })`.
- `safeReply`'s failure arm constructs `ReplyFailed.make({ message: messageOf(outcome.failure) })`.
- `command()` (~line 940) becomes:

```ts
const command = (event: HostCommandEvent): Effect.Effect<HostReplyV, SessionHostError, never> =>
  actor.ask(event).pipe(
    Effect.flatMap((reply) =>
      Match.value(reply).pipe(
        Match.tags({
          reply_ok: (ok) => Effect.succeed(ok),
          reply_failed: (failed) =>
            Effect.fail(new SessionHostError({ kind: "command_failed", message: failed.message })),
        }),
      ),
    ),
    Effect.mapError(toSessionHostError),
  );
```

Callers (`prompt` etc.) keep `.pipe(Effect.map((reply) => reply.result))` — field
access on the union narrows via `Match` or stays on `ReplyOk`'s shape if you type
`command()`'s success as `ReplyOk` (recommended: make `command()` return
`Effect<ReplyOk, SessionHostError>` — the `reply_failed` branch already fails).

### Machine `.on` collapse

Replace each command's three busy-state registrations (~lines 520-560) with one:

```ts
.on(
  [HostState.Working, HostState.Compacting, HostState.Crashed],
  HostEvent.PromptRequested,
  ({ state }) => Machine.reply(state, ReplyFailed.make({ message: "agent is already processing" })),
)
```

Wait — the three current messages differ per state ("agent is already processing" /
"cannot start a run while compacting" / "host crashed; retry"). Preserve them: the
handler receives `state` — use a small local function `busyReply(state, command)` that
picks the message from `state._tag` (a 3-arm `Match.value(state)` or object lookup).
Same for Steer/FollowUp. Net: 9 registrations → 3.

## Steps

1. Create `session-host-error.ts`; move `SessionHostError`, `toSessionHostError`,
   `messageOf`; add `kind` + update every `new SessionHostError({message…})` site
   (all in the split files — grep `new SessionHostError` to enumerate).
2. Create `session-machine.ts`; move the machine + run/compaction/title helpers
   verbatim first (pure move, tests stay green), then do the `HostReply` union and
   `.on` collapse.
3. Create `agent-events.ts`; move `handleAgentEvent`, `projectAgentEvent`,
   `stripUndefined` verbatim (keep the ADR-0001 `stripUndefined` comment — it
   explains a pi contract subtlety).
4. Slim `session-host.ts` to `create` + value + `dispose`; import from the new
   modules. Re-export the new modules' public types **from `session-host.ts`
   itself** (e.g. `export type { HostStateV } from "./session-machine.ts"`). Do NOT
   touch `isolate.ts` — it is plan 02's file and its existing re-exports from
   `session-host.ts` keep working unchanged.
5. Tests: `session-host.test.ts` + `remote-host.test.ts` must pass unchanged (they
   assert on messages, not error kinds — if one asserts error equality, extend with
   `kind` only if needed). `pnpm --filter @saku/hub test` must stay green (hub tests
   construct `SessionHost` through `in-process-worker.ts`).

## References

- Decomposition style: opencode `packages/core/src/session/{store,input,projector}.ts`
  — one concept per file, module doc header, sizes 300-600 lines.
- Reply-as-union: lutra `packages/frontend/src/editor/message.ts` (failure sets as
  `S.Union` of tagged structs) and foldkit `examples/api-cache/src/main.ts`
  (`Effect.result` + `S.Result` settle pattern).
- Error discriminants: saku's own `WireError` (`packages/wire/src/client.ts:80`,
  `code: Schema.Literals([...])`) is the house model; opencode
  `packages/core/src/git.ts` `Git.OperationError` is the reference model.
- Machine `.on` arrays: already used in this file
  (`.on([HostState.Idle, HostState.Interrupted], …)`).

## Verification

```sh
pnpm --filter @saku/worker typecheck && pnpm --filter @saku/worker test
pnpm --filter @saku/hub typecheck && pnpm --filter @saku/hub test
pnpm --filter @saku/deploy typecheck
```

## Definition of done

- `session-host.ts` ≤ ~600 lines; the machine, error type, and agent-event projection
  each live in their own module with a house-style header comment.
- `HostReply` is a `Schema.Union`; no `ok`-boolean plumbing remains.
- `SessionHostError` carries a required `kind`; every fail site passes one.
- Busy-state rejections are 3 registrations, messages preserved per state.
- All worker + hub tests green; public `SessionHost.create` surface unchanged.
