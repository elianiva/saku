# Plan — 02 · One wire server core, one session-command dispatch

Status: **planned** — parallel plan 02 of the refactor pass (see `README.md`).

## Owned files

- `packages/wire/src/server-core.ts` (new) + `packages/wire/src/session.ts` + `packages/wire/package.json` (new `"./server"` export)
- `packages/worker/src/daemon.ts`
- `packages/worker/src/session-commands.ts` (new) + `packages/worker/src/isolate.ts`
- `packages/hub/src/wire-core.ts`
- `packages/deploy/src/thread-do.ts` + `packages/deploy/src/rpc.ts`
- Tests: `packages/hub/test/hub-wire.test.ts`, `packages/hub/test/hub-real-worker.test.ts`, `packages/deploy/test/deploy.test.ts`

## Problem

Two near-identical wire-server implementations (`worker/daemon.ts` and
`hub/wire-core.ts`): `handleHello`, `respond`, `respondCommandFailure`, `handleCommand`
routing, `runConnection`, `broadcast`, `DECODE_COMMAND`, `isSessionCommand`, the
`Client` record — ~400 duplicated lines, already drifting (the daemon skips the
version check; only wire-core logs send failures). And the 16-case session-command
switch exists twice more (`daemon.ts` `runSessionCommand`, `thread-do.ts`
`runHostCommand`), each hand-rolling `default: { const exhaustive: never }`.

Code-judo: one transport-free connection core in `@saku/wire` parameterized by two
command-handler Effects; one shared `runSessionCommand` in `@saku/worker` (isolate-clean)
parameterized by host resolution. The daemon and the hub provide handlers; the daemon
and the thread DO provide host resolution. Behavior is identical — wire frames don't change.

## Design — `packages/wire/src/server-core.ts` (new)

Transport-free (no `ws` import — the wire package stays browser-safe; this module is
exported via a new `"./server"` subpath so the frontend bundle never sees it).

```ts
export interface ServerSocket {
  readonly send: (data: string) => void;
  readonly close: (code?: number, reason?: string) => void;
  readonly on: (event: "message" | "error" | "close", listener: (data: unknown) => void) => void;
  readonly once: (event: "message" | "error" | "close", listener: (data: unknown) => void) => void;
  readonly off: (event: "message" | "error" | "close", listener: (data: unknown) => void) => void;
}

export interface WireServerHandlers {
  readonly runHubCommand: (command: ThreadCommand | SkillCommand) => Effect.Effect<ResponsePayload, unknown, never>;
  readonly runSessionCommand: (threadId: string, command: SessionCommand) => Effect.Effect<ResponsePayload, unknown, never>;
}

export interface WireServerOptions {
  /** Resolves the auth token per hello (the daemon re-reads auth.json; the hub answers a constant). */
  readonly token: () => Effect.Effect<string, never, never>;
  readonly pid?: number;
  readonly handlers: WireServerHandlers;
  readonly log?: (message: string) => void;
}

export interface WireServerShape {
  readonly runConnection: (socket: ServerSocket) => Effect.Effect<void, never, Scope.Scope>;
  readonly close: () => Effect.Effect<void, never>;
}

export const makeWireServer = (options: WireServerOptions): Effect.Effect<WireServerShape, never, never>;
```

What moves in (from `wire-core.ts`, generalizing the daemon's version): `DECODE_COMMAND`,
`isSessionCommand`, `Client`, `send`, `broadcast`, `handleHello` (with the version check
— the daemon gains it, harmless: all consoles send `WIRE_VERSION`), `respond`,
`respondCommandFailure`, `handleCommand` (the `isSessionCommand` / missing-threadId
routing), `runConnection` (message/decode/hello routing, `Effect.callback` close wait,
finalizer), `closeClients`, and the canonical `messageOf` (review finding: 4 copies
exist — this becomes the exportable one).

Semantic notes:

- `handleCommand`'s failure path: `Effect.matchEffect` (or `Effect.tapBoth`) on the
  handler Effect → `respond` / `respondCommandFailure`. Unify the error channel as
  `unknown` and stringify at the frame boundary — exactly what both implementations
  already do.
- `send`: unify on the logging version (`Result.try` + `options.log` warn); the
  daemon's silent version is a bug.
- Hub's `SocketLike` (hub/src/socket.ts) and node `ws` sockets satisfy `ServerSocket`
  structurally — no changes to either.

`packages/wire/package.json`: add

```json
"./server": { "types": "./src/server-core.ts", "import": "./src/server-core.ts" }
```

to `exports`. Do not export it from `wire/src/index.ts`.

## Design — `packages/worker/src/session-commands.ts` (new)

```ts
export interface SessionCommandDeps<E> {
  /** Only called for mutating commands — the four reads never start a session (ADR 0004). */
  readonly hostFor: (threadId: string) => Effect.Effect<SessionHost, E>;
  /** The live host if the session already exists; None for never-started threads. */
  readonly readOnlyHost: (threadId: string) => Effect.Effect<Option.Option<SessionHost>, E>;
  /** `catalog.available()` already projected to wire info. */
  readonly availableModels: () => Effect.Effect<readonly WireModelInfo[], never, never>;
}

export const runSessionCommand = <E>(
  deps: SessionCommandDeps<E>,
  threadId: string,
  command: SessionCommand,
): Effect.Effect<ResponsePayload, E | SessionHostError, never>;
```

Implementation: `Match.value(command).pipe(Match.tagsExhaustive({ … }))` — the FIRST
backend `Match` in the repo, per lutra/foldkit idiom. Case map (verbatim from both
current implementations — keep payloads byte-identical):

- `get_entries` / `get_state` / `get_available_thinking_levels`: `readOnlyHost` →
  `Option.match` → no-host fallback (`GetEntriesResponse.make({entries: [], tailSeq: 0,
leafId: null})`, default `GetStateResponse` snapshot, `THINKING_LEVELS`) or the host
  call.
- `get_available_models`: `deps.availableModels()` (both impls serve catalog, host or not).
- Everything else (`prompt` … `get_session_stats`, `set_session_name`): `hostFor` →
  host method → `*Response.make`. Errors: `Effect.mapError` is no longer needed here —
  the caller owns `E`; host errors flow as `SessionHostError` naturally.
- No `default` arm, no `exhaustive: never` — `Match.tagsExhaustive` is the check.

Export from `packages/worker/src/isolate.ts` (one line — isolate already exists as a
package subpath; **do not** touch `worker/package.json`).

## Steps

1. **`packages/wire/src/server-core.ts`**: build per design, moving the code from
   `hub/src/wire-core.ts` and folding in the daemon's token-reading hello. Keep the
   comments that explain non-obvious behavior (the "socket closed between check and
   send" note, "reads never wake an env" stays in the session-commands module).
2. **`packages/wire/src/session.ts`**: export `READ_ONLY_COMMANDS` (the four tags)
   here next to `SessionCommand` — used by the shared dispatch instead of the two
   local sets. (`hub/hub.ts`'s own gate set is plan 04's file — leave it alone.)
3. **`packages/worker/src/session-commands.ts` + `isolate.ts` export**.
4. **`packages/worker/src/daemon.ts`**: delete `DECODE_COMMAND`, `isSessionCommand`,
   `Client`, `send`, `broadcast`, `handleHello`, `respond`, `respondCommandFailure`,
   `handleCommand`, `runConnection`, `handleConnection`, `closeClients` (in `close`).
   Keep: `handleHubCommand`/`runHubCommand` (registry-based), `handleSessionCommand`
   (now = `resolveThreadId` + shared `runSessionCommand` + `respond`), `hostFor`,
   `readOnlyHost`, `sessionStarted`, event sinks, startup/close lifecycle. Wire the
   core: `token: () => ensureAuthToken(fs).pipe(Effect.catch(() => Effect.succeed("")))`,
   `pid: process.pid`, `log` via the existing `log`. Also: `list_threads` — replace
   the sequential `for (const record of records) threads.push(yield* infoOf(...))`
   (~line 305) with `Effect.forEach(records, (r) => infoOf(r.id), { concurrency:
"unbounded" })`. While here, add the `code` discriminant to `DaemonError`
   (`code: Schema.Literals(["unknown_thread","empty_name","skills_not_served",
"unknown_command","missing_thread_id"])` — optional, all sites in this file).
5. **`packages/hub/src/wire-core.ts`**: becomes a thin wrapper: `makeWireCore(options)`
   = `makeWireServer({ token: () => Effect.succeed(token), pid, handlers: { runHubCommand
(the hub-shaped one — keep it here), runSessionCommand: hub.runSessionCommand } })`
   - the hub subscription (`hub.subscribe(onHubEvent)`) + `close`. `runHubCommand`'s
     switch stays for now (it is hub-specific; plan 04 owns Match conversion of
     `hub.ts`, not this file — keep `exhaustive: never` here or use Match; either is
     fine, pick Match for consistency).
6. **`packages/deploy/src/thread-do.ts`**:
   - Delete `runHostCommand` and `readOnlyWithoutHost`; `runCommand` calls shared
     `runSessionCommand` with `hostFor: (id) => self.hostFor(record)`,
     `readOnlyHost` (implement locally over `self.host` + `READ_ONLY`/`loadRecord`
     semantics — mirror `readOnlyHost` from daemon.ts), `availableModels`.
   - Fix the round trip at ~line 300: `Effect.tryPromise({ try: () =>
Effect.runPromise(SessionHost.create({…})) })` → `yield* SessionHost.create({…}).pipe(
Effect.mapError(toError("create host")))`.
   - Keep the typed channel: `runCommand` returns
     `Effect<{payload, tailSeq}, SessionHostError | RegistryError, never>`; only the
     `handleCommand` fetch boundary stringifies via `Effect.runPromise` + catch.
   - `readOnlyWithoutHost`'s nested ternary disappears with the shared dispatch.
   - Fix the `} from "@saku/env/remote";import {` line-join glitch (~line 32).
7. **`packages/deploy/src/rpc.ts`**: `threadIdleStop.disarm` — replace the
   `catch: () => undefined` + `Effect.catch(() => Effect.void)` magic with
   `Effect.tryPromise({…}).pipe(Effect.result, Effect.asVoid)` (or `Effect.option`).
8. **Tests**: `hub-wire.test.ts` and `hub-real-worker.test.ts` must pass unchanged
   (they exercise the same wire). `deploy.test.ts` must pass unchanged. If
   `hub-real-worker.test.ts` hits a behavior difference, that is a bug in the port —
   fix the port, not the test.

## References

- The exact shape being unified: read both files side by side —
  `packages/worker/src/daemon.ts` (~lines 100-180, 230-330, 520-610) and
  `packages/hub/src/wire-core.ts` (whole file, 301 lines).
- Match idiom: lutra `packages/frontend/src/editor/update.ts:218` and foldkit
  `packages/typing-game/client/src/page/home/update/update.ts` (`M.value(x).pipe(
M.withReturnType<T>(), M.tagsExhaustive({…}))`).
- Service-factory seam style: opencode `packages/core/src/session/store.ts` (one
  file, `Effect.gen` factory, typed interface).
- Concurrency: opencode `packages/core/src/context-epoch.ts:46`
  (`Effect.all(..., { concurrency: "unbounded" })`).

## Verification

```sh
pnpm --filter @saku/wire typecheck && pnpm --filter @saku/wire test
pnpm --filter @saku/worker typecheck && pnpm --filter @saku/worker test
pnpm --filter @saku/hub typecheck && pnpm --filter @saku/hub test
pnpm --filter @saku/deploy typecheck && pnpm --filter @saku/deploy test
```

## Definition of done

- `wire-core.ts` is a thin wrapper (< ~150 lines) around the shared core; the daemon
  no longer defines its own connection discipline.
- Exactly one copy of the session-command dispatch exists (shared module), used by
  daemon + thread DO; `grep -rn "runHostCommand\|runSessionCommand"` shows the shared
  one only.
- No `Effect.tryPromise(() => Effect.runPromise(…))` in `thread-do.ts`.
- All wire tests green; `list_threads` uses `Effect.forEach` with unbounded concurrency.
- No files edited outside the owned list.
