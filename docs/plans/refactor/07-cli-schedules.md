# Plan — 07 · CLI: Schedule-based waits, schema-decoded config

Status: **planned** — parallel plan 07 of the refactor pass (see `README.md`).

## Owned files

- `packages/cli/src/daemon.ts`
- `packages/cli/src/env.ts`
- `packages/cli/src/entry.ts` (read-only except the one small note below — likely no edits)

## Problem

1. Four hand-rolled poll loops (review P6-17): `ensureDaemon` + `stopDaemon`
   (`daemon.ts:85-110`) and `ensureEnvDaemon` + `stopEnvDaemon`
   (`env.ts:150-170`) — `for (i < 100) { yield* Effect.sleep("100 millis"); probe }`.
   The references use `Effect.retry`/`Schedule` (wire client already does:
   `packages/wire/src/client.ts` uses `Schedule.exponential`).
2. `readEnvConfig` (`env.ts:30-40`) does `JSON.parse(content) as EnvConfig` —
   saku's own config file, should be schema-decoded (review P4-11).

## Design

### 1. Probe-and-wait helper (replaces both ensure loops)

```ts
// daemon.ts
const waitForDaemon = (): Effect.Effect<DaemonStatus, never> =>
  daemonStatus().pipe(
    Effect.filterOrFail(
      (status): status is DaemonStatus & { pid: number } =>
        status.running && status.pid !== undefined,
      () => undefined,
    ),
    Effect.retry({ times: 99, schedule: Schedule.spaced("100 millis") }),
  );
```

`ensureDaemon` becomes: status check → `spawnDaemon()` → `waitForDaemon().pipe(
Effect.orElseFail(() => new Error("daemon did not come up …")))`. Same in
`env.ts` with `waitForEnvDaemon` (message: "env daemon did not come up (spawned pid
X); see …"). `Effect.filterOrFail` keeps the error channel empty; the 100-attempt
semantics (first probe + 99 retries) match today's loop exactly.

### 2. Stop loops

```ts
const waitForStop = (): Effect.Effect<void, never> =>
  daemonStatus().pipe(
    Effect.filterOrFail(
      (status) => !status.running,
      () => undefined,
    ),
    Effect.retry({ times: 49, schedule: Schedule.spaced("100 millis") }),
    Effect.catch(() => Effect.void), // 50 probes exhausted: give up silently, like today's break
  );
```

`stopDaemon`: SIGTERM → `waitForStop()` → `Option.some(pid)`. Mirror in `env.ts`.

### 3. `EnvConfig` schema

```ts
const EnvConfigSchema = Schema.Struct({
  envId: Schema.String,
  token: Schema.String,
  hubUrl: Schema.optional(Schema.String),
});
export type EnvConfig = Schema.Schema.Type<typeof EnvConfigSchema>;
```

`readEnvConfig`: read file (missing → `Option.none()`, keep the current
`Effect.catch`), then `Effect.try(() => JSON.parse(content))` →
`Schema.decodeUnknownOption(EnvConfigSchema)` → `Option` pipeline; the current
`Option.filter(envId/token length > 0)` moves into the schema via
`Schema.String.pipe(Schema.minLength(1))` or stays as a post-filter — pick the
schema refinement (`Schema.minLength(1)`), it reads better. `ensureEnvConfig`'s
write path and `spawnEnvDaemon` are unchanged.

### 4. `entry.ts`

Read-only. The plain `new Error(...)` usage-error failures are the CLI's boundary
(process exit path via `fail`) — leave them; add a one-line note to the `fail`
comment that usage errors are intentionally plain (single-owner CLI boundary,
opencode-style "plain Error at process edges"). Only touch `entry.ts` for that
comment if it doesn't collide with anything else.

## Steps

1. `daemon.ts`: `waitForDaemon` + `waitForStop`; rewrite `ensureDaemon`/`stopDaemon`
   on top; import `Schedule` from `effect`.
2. `env.ts`: mirror for the env daemon; add `EnvConfigSchema` + decode.
3. Verify CLI behavior manually (`saku daemon status`, `saku env status` while
   stopped) — the CLI has no test suite (`vitest run` passes with no tests); the
   proof is `pnpm --filter @saku/cli typecheck` + a manual run:
   `node packages/cli/src/entry.ts daemon status`.

## References

- Schedule retry: `packages/wire/src/client.ts` (`Schedule.exponential` in `start`),
  lutra `packages/frontend/src/offline/fill.ts:236`.
- `Effect.filterOrFail`: effect 4 beta core — the typed alternative to
  `Option.filter` inside Effects (same operator the current code uses in
  `Option`-space at `daemon.ts:36`).
- Schema decode of own config: opencode `AGENTS.md` (Schema helpers over
  `JSON.parse`) and saku's own `packages/wire/src/client.ts` `DECODE`
  (`Schema.decodeUnknownSync` hoisted at module scope — hoist
  `Schema.decodeUnknownOption(EnvConfigSchema)` the same way).
- Plain errors at the process edge: opencode `packages/opencode/src/effect/run-service.ts`
  (runPromise at entry; errors are the process's to print).

## Verification

```sh
pnpm --filter @saku/cli typecheck
node packages/cli/src/entry.ts daemon status
```

## Definition of done

- No `for (let i = 0; …)` polling loops remain in the CLI; all waits are
  `Effect.retry` + `Schedule`.
- `EnvConfig` is schema-decoded; no `as EnvConfig` cast.
- Manual `saku daemon status` / `saku env status` behave identically (start/stop
  smoke test if a local daemon is running).
- No files outside the owned list edited.
