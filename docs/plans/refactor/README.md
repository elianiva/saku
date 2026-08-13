# Refactor plans — Effect idiom pass

Status: **planned** — nine independent plans derived from the thermo-nuclear code-quality
review (2025, full codebase scan vs. opencode / lutra / foldkit idioms).

The review verdict: the core is already idiomatic (schema-first wire package,
`effect-machine` actors, `Deferred` correlation, `Layer`/`Context.Service`,
`Effect.callback` socket boundaries). The gaps are structural duplication, an inverted
promise seam, catch-all error types, hand-rolled exhaustiveness checks where `Match`
exists, and unvalidated casts where Schemas exist. These plans fix that **without
changing behavior** — no wire contract changes, no new dependencies, no new features.

## Why nine plans

Each plan owns a **disjoint set of files** so every plan can be executed by a separate
agent, in parallel, in the same checkout, and merged in any order. The ownership table
below is the contract: **a plan may not touch a file owned by another plan.** If a
change needs a file another plan owns, keep it out or leave a note — never edit it.

## File ownership map

| Plan                           | File                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Owning plan |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `01-kvstore-effect.md`         | `packages/store/src/*`, `packages/worker/src/do-session.ts`, `packages/hub/src/registry.ts`, `packages/hub/src/skills.ts`, `packages/deploy/src/kv.ts`, `packages/hub/test/registry.test.ts`, `packages/worker/test/do-session.test.ts`                                                                                                                                                                                                                 | 01          |
| `02-wire-server-core.md`       | `packages/wire/src/server-core.ts` (new), `packages/wire/src/session.ts`, `packages/wire/package.json`, `packages/worker/src/daemon.ts`, `packages/worker/src/session-commands.ts` (new), `packages/worker/src/isolate.ts`, `packages/hub/src/wire-core.ts`, `packages/deploy/src/thread-do.ts`, `packages/deploy/src/rpc.ts`, `packages/hub/test/hub-wire.test.ts`, `packages/hub/test/hub-real-worker.test.ts`, `packages/deploy/test/deploy.test.ts` | 02          |
| `03-session-host-decompose.md` | `packages/worker/src/session-host.ts`, `packages/worker/src/session-host-error.ts` (new), `packages/worker/src/session-machine.ts` (new), `packages/worker/src/agent-events.ts` (new), `packages/worker/test/session-host.test.ts`, `packages/worker/test/remote-host.test.ts`                                                                                                                                                                          | 03          |
| `04-hub-cleanup.md`            | `packages/hub/src/hub-error.ts`, `packages/hub/src/hub.ts`, `packages/hub/src/box.ts`, `packages/hub/src/provisioner.ts`, `packages/hub/src/server.ts`, `packages/hub/test/hub.test.ts`, `packages/hub/test/idle-stop.test.ts`, `packages/hub/test/provisioner.test.ts`, `packages/hub/test/mock-worker.ts`                                                                                                                                             | 04          |
| `05-worker-schemas.md`         | `packages/worker/src/model-catalog.ts`, `packages/worker/src/registry.ts`, `packages/worker/src/registry-error.ts`, `packages/worker/src/fake-provider.ts` (new), `packages/worker/package.json`, `packages/deploy/src/catalog.ts`                                                                                                                                                                                                                      | 05          |
| `06-env-schemas.md`            | `packages/env/src/daemon.ts`, `packages/env/src/protocol.ts`, `packages/env/src/local-env.ts`, `packages/env/test/env-daemon.test.ts`                                                                                                                                                                                                                                                                                                                   | 06          |
| `07-cli-schedules.md`          | `packages/cli/src/daemon.ts`, `packages/cli/src/env.ts`, `packages/cli/src/entry.ts`                                                                                                                                                                                                                                                                                                                                                                    | 07          |
| `08-frontend-effect.md`        | everything under `packages/frontend/src/` (`config.ts`, `wire.ts`, `commands.ts`, `update.ts`, `subscriptions.ts`, `message.ts`, `model.ts`, `format.ts`, `thread-pane.ts`, `rail.ts`, `view.ts`, new `projection.ts`)                                                                                                                                                                                                                                  | 08          |
| `09-deploy-hubdo.md`           | `packages/deploy/src/hub-do.ts`, `packages/deploy/src/static-provisioner.ts`, `packages/deploy/src/worker.ts`                                                                                                                                                                                                                                                                                                                                           | 09          |

Untouched files (owned by no plan — do not edit): `packages/wire/src/{client,envelope,hello,thread,skills,transport,version,index}.ts`,
`packages/hub/src/{core,index,socket,relay-core,relay,worker-ref}.ts`,
`packages/worker/src/{index,daemon-entry,tools,auth,paths,config-value}.ts`,
`packages/env/src/{index,entry,relay,remote,remote-node,paths}.ts`,
`packages/deploy/src/{env,alchemy.run}.ts`, `packages/deploy/{scripts,celld,generated}`,
`packages/hub/test/{relay,in-process-worker}.test.ts` + `mock-worker.ts` is owned by 04.

## Execution rules (every plan)

1. **Standalone green**: each plan must end with its package(s) typechecking and its
   tests passing on its own branch/change — plans must not depend on another plan's
   changes to compile (that is what the ownership table guarantees).
2. **Behavior-preserving**: this is a structural pass. Wire frames, machine
   transitions, reply semantics, CLI output, and tests must stay identical unless the
   plan explicitly says a specific error gains a field (those are additive).
3. **No new deps**: everything uses `effect@4.0.0-beta.106` + existing workspace
   packages. No new third-party packages.
4. **House style**: read `CONTEXT.md` for vocabulary (Thread vs session, Console,
   wire, env…). File headers: block comment "Feature (file.ts): …" like the current
   files. Errors: `Schema.TaggedError<X>()("X", {…})`. Services: `Context.Service`
   - `Layer.effect`. pi types stay opaque on the wire (ADR 0005) — never re-schema
     pi's types in `@saku/wire`.
5. **Verification commands**:
   - per package: `pnpm --filter <pkg> typecheck && pnpm --filter <pkg> test`
   - deploy (bun): `pnpm --filter @saku/deploy typecheck && pnpm --filter @saku/deploy test`
   - after everything merges: `pnpm typecheck && pnpm test` at the root.
6. **Definition of done** (every plan): tests green, typecheck green, no TODO/stub
   comments, no shims or aliases left behind, no file pushed over ~1000 lines (split
   instead), diff does nothing beyond the plan's scope.

## Cross-cutting notes (read before starting)

- **`messageOf`** (`error instanceof Error ? error.message : String(error)`) exists
  in four places: `hub/src/hub-error.ts`, `worker/src/session-host.ts`,
  `frontend/src/commands.ts`, and inline in `worker/src/daemon.ts`. Plan 02 adds the
  canonical `messageOf` to `@saku/wire` (exported from the new `server-core.ts`).
  Plans 03/04/08 may switch their local copy **only if 02 has already merged**;
  otherwise keep the local one. Do not block on this.
- **Error discriminants are staged**: `HubError` (04) and `RegistryError` (05) get
  their `kind`/`op` fields as `Schema.optional` so plans 01/02/06 don't break while
  other plans migrate their own construction sites. After all plans merge, a
  follow-up can make them required.
- **`READ_ONLY_COMMANDS`**: currently duplicated in `hub/src/hub.ts` and
  `deploy/src/thread-do.ts`. Plan 02's shared `runSessionCommand` makes the
  read-only dispatch live in exactly one place; the hub's own gate set stays local
  (it is the env gate, a different concern).
- **Reference repos** (for idiom ground truth — cite these in PRs):
  - `~/Development/repos/opencode` — `packages/core/src/fs-util.ts` (Effect.fn +
    Effect.try → TaggedError), `packages/core/src/session/store.ts` (Context.Service
    - Layer.effect shape), `packages/core/src/git.ts` (errors with operation
      literals), its `AGENTS.md` (no try/catch, no `any`, bind services to named
      variables, early returns).
  - `~/Development/personal/apps/lutra` — `packages/frontend/src/editor/update.ts:218`
    (Match.tagsExhaustive + withReturnType), `editor/command.ts:98` (Effect.tryPromise
    {try, catch} → TaggedError), `editor/message.ts` (failure-set unions),
    `root/subscriptions.ts:14` (Stream.fromPubSub), `luts/store.ts:46` (passthrough
    catch), `offline/fill.ts:236` (Effect.retry + Schedule.exponential),
    `gpu/backend.ts:135` (catchTag → die for Layer<never>), `encode/worker-layer.ts:40`
    (Effect.runFork escape hatch), `errors.ts` (TaggedErrorClass shape).
  - `~/Development/repos/foldkit` — `packages/typing-game/client/src/update.ts`
    (submodel delegation, Command.mapMessages), `page/home/update/update.ts`
    (M.tagsExhaustive), `message.ts` (m() + S.Union), `command.ts` (Command.define +
    catch → Failed message), `subscription.ts` (Subscription.make + entry),
    `examples/websocket-chat/src/main.ts` (Stream.callback + Queue.offerUnsafe +
    acquireRelease), `examples/api-cache/src/main.ts` (Effect.result + S.Result).

## Review → plan mapping (nothing lost)

| Review finding                                                            | Plan |
| ------------------------------------------------------------------------- | ---- |
| KvStore promise seam inverted (promise only at the pi seam)               | 01   |
| Duplicated wire-server discipline (daemon vs hub wire-core)               | 02   |
| Duplicated 16-case session-command dispatch                               | 02   |
| `Effect.tryPromise(() => Effect.runPromise(...))` round trip in thread-do | 02   |
| `catch: () => undefined` magic in rpc.ts idle-stop disarm                 | 02   |
| session-host.ts at 1149 lines                                             | 03   |
| Hand-rolled `HostReply {ok,…}` instead of tagged union                    | 03   |
| `SessionHostError` without discriminant                                   | 03   |
| Busy-state `.on` registrations (9 → 3)                                    | 03   |
| Catch-all `HubError`/`BoxError` without discriminant                      | 04   |
| `hub.ts` listThreads sequential loop; JSON.stringify equivalence          | 04   |
| `pollUntilReady` recursion instead of Schedule                            | 04   |
| `AuthJsonCredentialStore.load` Effect→Promise→Effect round trip           | 05   |
| models.json manual parse + throw-driven builders                          | 05   |
| `JSON.parse(...) as ThreadRecord` casts                                   | 05   |
| Fake provider duplicated (worker vs deploy catalog)                       | 05   |
| `runOp` switch → Match; `EnvHandle` has no schema                         | 06   |
| `describeEntry` double runPromise                                         | 06   |
| Hand-rolled retry loops in cli (4×)                                       | 07   |
| `EnvConfig` cast decode                                                   | 07   |
| `resolveConfig` async/Promise in frontend                                 | 08   |
| foldWireEvent non-exhaustive switch with silent default                   | 08   |
| `event as SessionWireEvent` casts / format.ts unknown-poking              | 08   |
| `Effect.catch` catch-alls in commands                                     | 08   |
| hub-do promise cache + handlePush switch/cast                             | 09   |
