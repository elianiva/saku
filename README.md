# saku — 作, the software factory

A control plane for pi coding agents, in the managed-agents shape:

```
frontend ⇄ hub ⇄ worker ⇄ env
```

A **hub** (one Durable Object per deployment — Cloudflare Workers, or celld locally)
owns the thread registry, provisions environments, and routes one **wire** protocol.
Each **worker** (a Durable Object per thread) runs pi-agent-core's `Agent` + `Session`
over DO storage — the brain. Each **env** is the hands: the local machine (an env
daemon that dials out to the hub) or a **Box** (ascii.dev sandbox). Consoles —
the foldkit frontend (next) and a thin CLI — never hold session state; they attach,
tail, and command.

See [`CONTEXT.md`](./CONTEXT.md) for the vocabulary, `docs/plans/0001-durable-spine.md`
for the rework plan, and `docs/adr/` for the decisions (highlights: managed-agents
spine with per-thread DO workers; cloud-primary with a celld twin; one env daemon for
local and Box; the wire is pi's vocabulary verbatim over WebSocket; pi-only; no
approval gates; hub-hosted skills).

## Layout

| Package           | Role                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/wire`   | the wire protocol: JSONL over WebSocket, hello/version, thread + session + skills commands, typed `WireClient` (an effect-machine actor)   |
| `packages/store`  | the durability seam: the `KvStore` Effect service (the Durable Object storage contract) with memory, file, and DO storage backend layers                                                                 |
| `packages/hub`    | the control-plane DO: registry, Box provisioning, skills store, auth, routing, fan-out                                                     |
| `packages/worker` | the thread DO: pi-agent-core `Agent` + `Session` over DO storage, env client, idle-stop                                                    |
| `packages/env`    | the hands daemon: pi tool surface over a streaming protocol, local and in-Box                                                              |
| `packages/cli`    | local daemon management: `saku env start\|stop\|status`                                                                                    |
| `packages/deploy` | the deployment's own code: the alchemy program (`alchemy.run.ts`), the workerd DOs (`SakuHubDO`/`SakuThreadDO`), the celld twin (`celld/`) |

## Status

The durable spine's milestones M0–M4 are built and tested:

- **M0 — wire**: the protocol (JSONL over WebSocket, hello/version, threads,
  sessions, skills), the typed `makeWireClient`.
- **M1 — worker on DO storage**: `DoSessionRepo` over the `KvStore` seam (pi's
  own backend conformance suite passes), the `SessionHost` as an effect-machine
  actor with lazy sessions and trail recovery.
- **M2 — hub**: the control-plane core (`makeHub` — durable registry, worker
  seam, skills store, env gate), the wire server, full-stack integration over
  real WebSockets.
- **M3 — env daemon**: `packages/env` (protocol, daemon, `RemoteEnv`, relay
  client, Box bundle), Box provisioning through the one-shot API with a
  `host --private` health probe, the hub relay (register/attach/pipe),
  idle-stop, and the `saku env start|stop|status` CLI. The agent's tools
  execute on a real env daemon through the hub's relay, and the built Box
  bundle serves the tool surface (live-verified).
- **M4 — deploy + docs**: `packages/deploy` — the deployment's own code,
  proven in real workerd. The alchemy program declares the Worker + the two
  DO namespaces + the deployment secret; the DOs are plain workerd classes
  (no alchemy runtime in the entry bundle) sharing the hub/worker/env cores.
  The dev harness deploys the stack to local workerd and the integration
  suite drives it over the real wire: create → lazy env provisioning →
  prompt → run in the thread DO → entries back, idle-stop through the DO
  alarm (env stopped → resume on the next prompt), the env relay
  register/attach/exec through the hub DO, and `delete_thread` teardown.
  The celld twin (`celld/wrangler.jsonc` + `index.ts`) ships the same code
  for self-hosted fleets — see `packages/deploy/celld/README.md`.
- **M5 — the console (first slice)**: `packages/frontend` — the foldkit
  console (humanlayer-style, pseudo-TUI, rose pine light): the thread rail
  (list, quick start, auto-title, state/mode/env glyphs, delete), the thread
  pane (entry trail — messages, tool calls, tool results, model errors —
  live run with streaming message + tool activity, abort), and the composer.
  Driven by the real worker over the wire; the dev loop boots against the
  local daemon via the vite `/__saku` bootstrap. The worker's `SAKU_FAKE_MODEL`
  scripted provider keeps the loop credit-free.

Remaining: the console's later slices (model picker, settings, diff review,
terminals/portals, skills UX, queueing semantics, the deployed hub's login)
— see the plan.

## Prerequisites

- **Node ≥ 26** — source runs directly via type stripping, no build step (shipped
  code must therefore avoid `!` non-null assertions and constructor parameter
  properties, which strip mode rejects).
- **pnpm 11** — `packageManager` is pinned in `package.json`.
- **bun** — `packages/deploy` runs on bun: tests (`bun test`), the local
  deployment harness, and `bun alchemy deploy`.
- **an opencode gateway** (for real prompts) — saku's only builtin provider is
  `opencode-go`; the worker reads credentials from `~/.pi/agent/auth.json` and
  custom providers from `~/.pi/agent/models.json` (pi's own files, overridable
  with `PI_CODING_AGENT_DIR`). No other providers are registered. For a
  credit-free loop, `SAKU_FAKE_MODEL=1` in the daemon's environment adds the
  scripted `saku-fake` provider.

## Setup

```bash
pnpm install
```

There is no build step for development: everything runs from source. `pnpm build`
(tsdown) exists for packaging and is exercised by CI-style checks.

## Running locally

The local stack is two daemons + a console, all talking over the wire:

```bash
saku daemon start   # the worker daemon (one worker per thread, DO storage on disk)
saku env start      # the env daemon ("local" mode hands: tools run on this machine)
```

Both auto-start on demand — any `saku` command boots the daemon it needs; stop
them with `saku daemon stop` / `saku env stop`, check them with `status`. State
lives in `~/.saku/` (`SAKU_HOME` overrides): the worker's URL + token for
consoles, and the thread trail.

Drive the worker with the CLI:

```bash
saku list                              # threads: id, name, mode, state, env, cwd
saku new <name> [--cwd <dir>] [--mode local|sandbox|any]
saku rm <thread>                       # id or name prefix
```

Boot the console against the local daemon:

```bash
pnpm --filter @saku/frontend dev
```

Vite serves the console on `:5173`; its `/__saku` bootstrap reads the daemon's
published URL and token from `~/.saku/` and connects straight to the worker (no
deployed hub needed). Quick-start a thread, and the prompt runs on the worker
through the env daemon — streaming back over the wire.

To run against a _deployed hub_ instead, start the env daemon in relay mode
(`saku env start --hub <url>`) and open the console on the deployment's domain
(no bootstrap → the app falls back to same-origin `/ws`).

## Development

```bash
pnpm typecheck   # turbo: tsc --noEmit in every package
pnpm test        # turbo: vitest per package (deploy runs bun test)
pnpm build       # turbo: tsdown per package
pnpm lint        # oxlint (tsc is the type authority — see vite.config.ts)
pnpm fmt         # format everything
pnpm check       # fmt + lint in one
```

The wire is the integration seam: the whole system is verified with unit and
integration tests against it (no CLI smoke; the frontend is the next consumer).

## CI

`.github/workflows/ci.yml` runs on every push and PR: setup (Node 26, pnpm,
bun), `pnpm typecheck`, `pnpm lint`, `vp fmt --check`, `pnpm test`, `pnpm
build`. The deploy tests exercise the real stack in local workerd (ephemeral
ports, `SAKU_FAKE_MODEL`), so CI needs no cloud credentials.

## Deploying

The deployment lives in `packages/deploy` (the same code both hosts ship):

- **Cloudflare** (production): `bun alchemy deploy` with the secrets as env
  vars — `BOX_API_KEY` (Box provisioning) and `SAKU_ENV_*` for the
  static-provisioner shape (a single configured env daemon instead of Boxes).
  Model credentials are separate: the local daemon reads pi's `auth.json` +
  `models.json`; a deployed worker resolves the opencode gateway's
  `OPENCODE_API_KEY` off its bindings (not declared by the program — add it
  as a deployment secret when prompts need a real model).
- **celld** (development/self-hosted): `celld deploy packages/deploy/celld
--bucket <s3-bucket>` with esbuild on PATH — the wrangler twin mirrors the
  same bindings; vars are plaintext in the fleet bucket (trust domain).

Details in `packages/deploy/celld/README.md`.

## Conventions

Tooling conventions follow pi where it matters: skills, prompt templates, sessions,
settings — pi's own vocabulary and extension surface ride through the worker
unmodified. In the wire, pi's public types cross verbatim; saku adds only what pi
lacks (threads) — extend pi, never shim it.
