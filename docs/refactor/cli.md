# Refactor report: `packages/cli`

Audited against the house rules (`AGENTS.md`, `docs/style.md`) and the
idiom ground truth (`~/Development/repos/effect`, `~/Development/personal/apps/lutra`).

---

## Overview

`@saku/cli` is the scripting surface of saku: a one-shot Node bin (`src/entry.ts`)
that stewards the local worker/env daemons and drives the wire protocol.

```
src/cli-error.ts     25  lines  CliError (Schema.TaggedError, literal codes)
src/daemon.ts        47  lines  worker daemon lifecycle config
src/env.ts          128  lines  env daemon lifecycle config + env identity (env.json)
src/lifecycle.ts    207  lines  shared spawn/probe/poll/stop choreography
src/entry.ts        666  lines  arg parsing, all 12 commands, formatting, process edge
total              1073
```

The good news, stated once: this package is already Effect-first and largely
house-style-compliant. The lifecycle's four imperative `for(i<100){sleep;probe}`
loops are gone (now `Effect.retry` + `Schedule`, lifecycle.ts:136-152). Errors are
tagged (`CliError`, `WireError`). Dispatch is `Match` with `withReturnType`.
`EnvConfig` is Schema-typed and decoded at the boundary. The daemon configs are a
clean "third daemon = new config, not a copy" seam. Nothing here needs a
rewrite — but there are one security bug, one testing gap, one dead build
reference, and ~150 lines of pure copy-paste that a couple of helpers would
delete.

---

## Critical Issues

### 1. The deployment secret is written world-readable — the comment lies, the worker doesn't

`env.ts:50-64` `ensureHubToken` reads/writes `~/.saku/auth` and claims
"creating it (0600) when absent — the deployment secret":

```ts
yield* fs.writeFileString(paths.authPath, `${token}\n`);
```

No `mode: 0o600`. `@effect/platform`'s `writeFile` passes `mode: options?.mode`
straight to `node:fs.writeFile` (verified in
`@effect+platform-node-shared/.../NodeFileSystem.js` line ~615), whose default is
`0o666 & ~umask` — i.e. **0644 on typical machines**. The directory is 0700 so
the file is usually protected *by the directory*, but the claim is wrong, and if
`SAKU_HOME` points anywhere shared the token leaks.

The worker's own implementation of the identical function does it right
(`worker/src/auth.ts:38-45`): `writeFileString(paths.authPath, token, { mode: 0o600 })`
**and** a follow-up `chmod(paths.authPath, 0o600)`. The CLI version is missing
both. Fix: delete `ensureHubToken` and use the worker's exported `ensureAuthToken`
(see Critical Issue 3) — the mode bug is what duplication produces.

`ensureEnvConfig` (env.ts:66-88) has the same omission on `env.json`, which also
holds a credential (the env protocol token).

### 2. The most failure-prone module in the package has zero tests

`lifecycle.ts` — spawn, raw-fd log plumbing, probe, 100ms polling, SIGTERM stop,
the "spawned pid never answers" timeout path — is the trickiest code in the CLI
and it is **completely untested**. There is no `packages/cli/test/` directory at
all (tsconfig.json:6 `include`s a `test` dir that doesn't exist; vitest runs with
`passWithNoTests: true`). Every sibling package has a real suite (`wire/test`,
`worker/test`, `env/test`, `hub/...`). The `ensure`/`waitForUp`/`waitForStop`
polling behavior (including the `Effect.retry` schedule that replaced the old
loops) is exactly the kind of timing code the house style demands `Clock`-testable
— and it is untested, so the retry rewrite can regress silently.

Minimum: a test that drives `ensure` against a fake probe/readToken (the
`DaemonLifecycleConfig` seam makes this trivial — no real child processes
needed), and one for `stop`'s already-gone path.

### 3. The auth-token read logic is triplicated, and it has already diverged

Three copies of "read `~/.saku/auth`, trim, treat empty as absent":

- `worker/src/auth.ts` — `readAuthToken` / `ensureAuthToken`, exported from
  `@saku/worker` (`index.ts:13`), correct mode, takes `(fs, paths)` explicitly.
- `cli/src/daemon.ts:34-40` — `workerLifecycle.readToken`, re-implemented inline
  with `Effect.map`/`Effect.catch`.
- `cli/src/env.ts:52-58` — `ensureHubToken`'s read half, re-implemented again,
  plus the buggy write half.

The CLI already imports from `@saku/worker` (Paths, PathsLive). It should import
`readAuthToken` / `ensureAuthToken` too. Deleting the two inline copies removes
the divergence that produced Critical Issue 1.

### 4. Dead build config: `src/index.ts` does not exist

`package.json` exports `"."` → `./src/index.ts`; `tsdown.config.ts` lists
`src/index.ts` as an entry. The file is gone (not even tracked in jj). `dist/`
holds a stale build from Aug 14 including an empty `dist/index.js`. Either the
next build fails or it silently emits an empty module for the package's main
export. `@saku/cli` is a bin-only package — drop the `"."` export and the
`src/index.ts` entry, keep only `src/entry.ts`.

---

## Structural Improvements (code judo)

### 1. One helper kills 14 copies of the "refused" catch (≈70 lines)

`entry.ts` repeats the identical `Effect.catchIf(WireError code "refused" →
re-fail with a message)` block **14 times** (lines 79, 131, 155, 172, 205, 258,
278, 303, 352, 371, 402, 439, 457, 469), each ~5 lines plus a bespoke message.
The only variation is the action noun.

```ts
const refuse = (action: string) =>
  Effect.catchIf(
    (error): error is WireError => error instanceof WireError && error.code === "refused",
    () =>
      Effect.fail(
        new WireError({
          code: "refused",
          message: `worker refused the connection (${action}) — it may have just shut down; try: saku daemon status`,
        }),
      ),
  );
```

Then `client.listThreads().pipe(refuse("list threads"))`. 14 call sites shrink to
14 one-liners; the "may have just shut down" tail lives in one place. This is the
single highest-ROI change in the package.

### 2. Scope the client connection — `withClient(fn)`, not manual connect/disconnect

Every command is `const client = yield* connect; …; yield* client.disconnect();`
— 12 `client.disconnect()` calls (entry.ts), all on the *success* path only. Any
`Effect.fail` in between skips disconnect. The process exits after, so this is
latent rather than live, but it's the wrong shape: the connection is a resource.

```ts
const withClient = <A, E>(
  fn: (client: WireClientApi) => Effect.Effect<A, E>,
): Effect.Effect<A, E, Paths | FileSystem.FileSystem> =>
  Effect.acquireRelease(connect, (client) => client.disconnect()).pipe(Effect.flatMap(fn));
```

All 12 `disconnect()` calls disappear, failure paths release too, and each
command body becomes just "do work, log". (The frontend already uses
`Effect.acquireRelease` for its wire listeners — `frontend/src/wire.ts:81` — so
this matches house idiom.)

### 3. Share the "resolve thread or fail" preamble

`cmdRm` (entry.ts:146-172) and `cmdArchive` (entry.ts:424-448) share the same
five-line preamble: `connect → listThreads → resolveThread → fail CliError
"resolution"`. Extract `resolveThreadArg(client, arg)` returning the resolved
thread or a `CliError`. Two commands collapse to:

```ts
const resolved = yield* resolveThreadArg(client, arg);   // fails with CliError
```

`cmdPiImport`/`cmdPiList` similarly share the `listPiSessions` + refused-handling
preamble (entry.ts:202-243, 278-312) — the `refuse` helper from #1 makes the
shared extraction obvious.

### 4. Kill the repeated `Match.withReturnType<…>` incantation

The full annotation `Effect.Effect<void, WireError | CliError, Paths |
FileSystem.FileSystem>` is written out **5 times** (entry.ts:322, 339, 488, 551,
635). `Match.withReturnType` is the correct tool (house style), but the repeated
spelling is noise that will drift. Two aliases:

```ts
type CliProgram = Effect.Effect<void, WireError | CliError, Paths | FileSystem.FileSystem>;
type DaemonProgram = Effect.Effect<void, CliError, Paths | FileSystem.FileSystem>;
```

`cmdDaemon`/`cmdEnv` use `DaemonProgram` (no wire errors — they never touch the
worker connection), the rest `CliProgram`.

### 5. Split `entry.ts` — it holds three concepts and every command

666 lines: arg parsing + dispatch (main, flagValue, usage), all 12 command
handlers, output formatting (pad, fmtWhen), and the process edge (fail,
runPromise). Per house style ("one concept per file; split instead") this is a
`commands.ts` (the `cmd*` handlers + `pad`/`fmtWhen`) and a thin `entry.ts`
(parse `process.argv`, dispatch via `Match`, provide layers, runPromise + exit).
The split pays for itself the moment the wiring helpers above land — they belong
in `commands.ts` with the handlers.

### 6. `daemon.ts` probe: `Effect.timeoutOption` deletes the map/catch dance

`daemon.ts:27-33`:

```ts
const hello = yield* client.connect().pipe(
  Effect.timeout("2 seconds"),
  Effect.map(Option.some),
  Effect.catch(() => Effect.succeed(Option.none())),
);
```

is exactly `Effect.timeoutOption("2 seconds")`. The whole probe becomes:

```ts
const hello = yield* client.connect().pipe(Effect.timeoutOption("2 seconds"));
yield* client.disconnect();
return Option.map(hello, (value) => ({ pid: value.pid, version: value.version }));
```

Also drops a catch-all `Effect.catch` (style.md bans catch-alls where the failure
set is known).

---

## Effect Migration (Promise → Effect)

Honest assessment: **the package already complies with the promise rule.**
There are no saku-owned Promise APIs to convert. The three promise edges are the
legitimate ones the house style names:

- `entry.ts:661` `await Effect.runPromise(...)` — the CLI entry seam. Correct.
- `lifecycle.ts:96-119` `Effect.tryPromise` around `node:fs/promises.open` and a
  hand-built pid promise — the child_process platform edge. Correct in kind; see
  the two tightening notes below.
- `env.ts:114` `Effect.tryPromise(async () => await env.connect())` — the
  `RemoteEnv` pi-contract seam (`RemoteEnv.connect()` is promise-shaped because
  `ExecutionEnv` is pi's promise contract; it's internally `Effect.runPromise`,
  remote.ts:133). Correct.

Tightening opportunities at those edges:

1. **`env.ts:114` — don't make the CLI re-enter the promise.** `RemoteEnv` runs
   its whole connect as an `Effect` internally, then wraps it in `runPromise` for
   pi. The CLI then wraps it *back* in `tryPromise`. Export a thin Effect
   (`connectEnv(identity): Effect<EnvHelloOk, EnvConnectionError>` from
   `@saku/env`) so the promise round-trip happens once, in the package that owns
   the seam. The probe also does `env.close()` manually after `yield*` — an
   `Effect.acquireRelease`/`ensuring` would survive interruption.
2. **`lifecycle.ts:107-118` — the pid promise is subtle for no reason.** The
   `new Promise((resolve, reject) => { child.once("error", reject); if (child.pid !== undefined) resolve(child.pid); })`
   resolves synchronously in the executor and otherwise waits forever for
   `error`. `Effect.tryPromise` wraps it so the sync-throw case is caught, but an
   `Effect.async`/`callback` with the `error` listener would say the same thing
   without the "resolves without waiting" cleverness. Low priority — the comment
   explains it, and it works.
3. **`fail()` re-provisions the logger it's already inside** (entry.ts:68-72):
   the catch runs *outside* the `Effect.provide([…, Logger.layer([CliLogger])])`
   scope, so `fail` re-provides the logger to print one line. Move the catch
   *inside* the provide scope:

   ```ts
   await Effect.runPromise(
     Effect.provide([NodeFileSystem.layer, Logger.layer([CliLogger]), PathsLive])(
       main().pipe(Effect.catch((error) => Effect.sync(() => fail(error)))),
     ),
   );
   ```

   and `fail` keeps its `process.exit(1)` but drops the `Effect.runSync` +
   re-provision. (Alternative: `console.error` at the edge — but keeping the
   logger makes `CliError` messages flow through the same formatter.)

4. **Optional: `ChildProcessSpawner`.** The platform's spawner service would
   replace the raw `child_process.spawn` + `NFS.open` fd plumbing in `spawn()`,
   but it lives in `effect/unstable/process/...` — too unstable to justify for a
   working, commented, 30-line function. Leave it; note it for when `unstable`
   stabilizes.

No `Effect.promise`, no `async` saku code, no `tryPromise(() => runPromise(...))`
anywhere — that part of the audit is clean.

---

## Type Safety Improvements

1. **`cmdNew`'s mode coercion silently swallows typos** (entry.ts:646-647):

   ```ts
   const mode: ThreadMode = modeArg === "sandbox" || modeArg === "any" ? modeArg : "local";
   ```

   `saku new x --mode sandboxx` silently becomes `local` — a mode is a *hard
   thread-identity pin* per CONTEXT.md ("switching modes mid-thread corrupts a
   thread's identity"), so silently degrading it is the worst possible failure
   mode. Decode with `Schema.decodeUnknownOption(ThreadMode)` (or a literal
   guard) and fail with `CliError "usage"` on a miss.

2. **`flagValue` grabs the next token blindly** (entry.ts:626-632): `saku new
   --cwd --mode sandbox` yields `cwd = "--mode"`. Check the next token isn't a
   flag (`rest[index + 1]?.startsWith("-")`) before accepting it, or route all
   flag parsing through one tiny helper (see Minor Cleanups #3 — the `--hub`
   inline parsing is a second, divergent parser).

3. **`DaemonStatus`'s optional fields** (`pid?/version?/cwd?/url?/token?`,
   lifecycle.ts:18-27) are `undefined` sentinels; house style says seam shapes
   answer with `Option`. This one is internal and the `isConnected` predicate
   (lifecycle.ts:123-129) handles it, so it's a style nit — but a
   `DaemonStatus = { running: false } | { running: true; pid; version; url;
   token; cwd? }` union would make the "probed" state impossible to misread and
   delete the `isConnected` type predicate entirely.

4. `status()` returns typed locals (`const result: DaemonStatus = …`,
   lifecycle.ts:62, 70-72) — unnecessary annotations; let inference do it
   (AGENTS.md).

5. `readEnvConfig`'s `JSON.parse(content) as unknown` (env.ts:44-46) is a
   justified boundary cast with a SAFETY comment and immediate Schema decode —
   compliant with style.md's "schemas over casts". Keep as is.

---

## Minor Cleanups

1. **Flatten the nested provides** (entry.ts:660-666): `Effect.provide(A)(
   Effect.provide(B)(main()))` → one array `[NodeFileSystem.layer,
   Logger.layer([CliLogger]), PathsLive]` (and see Effect Migration #3 — the
   catch belongs in the same scope).
2. **`resolveEnvEntry`** (env.ts:24) is exported but only used by
   `envLifecycle`; inline it.
3. **`cmdEnv`'s `--hub` parse** (entry.ts:640: `rest.includes("--hub") ?
   rest[rest.indexOf("--hub") + 1] : undefined`) is a second, hand-rolled flag
   parser next to `flagValue`. Reuse `flagValue(["--hub"], undefined)`.
4. **`cmdList`/`cmdPiList` row loops** (entry.ts:99-109, 232-240): build one
   string with `map().join("\n")` and log once — the table is already one
   `logInfo` per row plus a header; a single `logInfo` of the joined table reads
   better and cuts log-line overhead.
5. **`cmdDaemon stop/restart`'s `Option.match` → `Option.map` + template**
   (entry.ts:501-517): the `onNone`/`onSome` arms just pick a string; a small
   `const said = Option.map(pid, (p) => `stopped (pid ${p})`).pipe(Option.getOrElse(() => "not running"))`
   is less ceremony. Cosmetic.
6. **`env.ts` reads `SAKU_HOME` imperatively via `@saku/env`'s
   `getEnvConfigPath()`/`getEnvLogPath()`/`getEnvUrlPath()`** (which call
   `process.env.SAKU_HOME` at call time, env/paths.ts:13-16) while `daemon.ts`
   resolves the same root through the `Paths` service (`Config` + `PathsLive`).
   Two env-reading mechanisms in one package. The env paths are all
   `<sakuDir>/env.*` — derive them from `PathsLayout.sakuDir` in the CLI (and
   note that the spawned env daemon re-reads the env var itself, which is fine —
   the CLI passes the config explicitly). At minimum, acknowledge the split;
   ideally, one mechanism.
7. `dist/` is checked in and stale (empty `index.js`, Aug 14) — clean it up or
   gitignore it alongside the Critical Issue 4 config fix.

---

## Suggested order of operations

1. **Critical 1 + 3** (one change): delete `ensureHubToken` and the inline
   `readToken`, import `ensureAuthToken`/`readAuthToken` from `@saku/worker`;
   pass `{ mode: 0o600 }` where env.json is written. Security fix first.
2. **Structural 1 + 2 + 3**: `refuse`, `withClient`, `resolveThreadArg` — this
   alone removes ~120 lines and every failure-path leak from entry.ts.
3. **Structural 4 + 6, Type Safety 1 + 2, Minors 1-3**: the mechanical pass.
4. **Critical 2**: tests for `lifecycle.ts` (fake probe/readToken against the
   `DaemonLifecycleConfig` seam) and the argument-resolution helpers.
5. **Critical 4 + Minor 7**: fix the package config, clean dist.
6. **Structural 5**: split `entry.ts` last — it's cosmetic until 1-3 land and
   the file shrinks naturally.
