# saku — 作, the software factory

A control plane for [pi coding agents](https://github.com/earendil-works/pi-coding-agent):
durable, per-thread agents with sandboxed hands, driven from a web console or a
CLI. One thread is one Durable Object — state lives in an append-only entry
trail that survives restarts, so the agent process itself is disposable.

```
frontend ⇄ hub ⇄ worker ⇄ env
```

A **hub** (one Durable Object per deployment — Cloudflare Workers, or celld
locally) owns the thread registry, provisions environments, and routes one
**wire** protocol. Each **worker** (a Durable Object per thread) runs
pi-agent-core's `Agent` + `Session` over DO storage — the brain. Each **env** is
the hands: the local machine (an env daemon that dials out to the hub) or a
**Box** (ascii.dev sandbox — **incomplete**, ADR 0008). Consoles — the foldkit frontend and a thin CLI —
never hold session state; they attach, tail, and command.

## Features

- **Threads as durable objects** — a thread is a pi session plus registry
  metadata (name, cwd, mode), rebuilt from its trail on any restart. Create,
  list, and delete threads; auto-titled quick starts run the first prompt in
  one gesture.
- **Live runs over the wire** — messages, tool calls, tool results, and model
  errors stream back in real time; runs can be aborted. Thread state
  (`idle` / `working` / `interrupted`) broadcasts as `thread_changed` events.
- **Remote hands** — tools execute on an env daemon: your own machine (local
  mode, reachable through the hub's relay with no open ports) or a disposable
  sandbox VM (sandbox mode — Freestyle, ADR 0008; the ascii.dev Box
  integration is **incomplete**; both are lazily provisioned, stopped when
  idle, resumed on the next prompt). A thread's mode is pinned at creation.
- **Web console** — a foldkit frontend (humanlayer-style pseudo-TUI, rose pine
  light): thread rail, entry trail with live tool activity, and a composer.
  Boots against the local daemon for development or any deployed hub.
- **Pi-native** — the wire carries pi's own session vocabulary verbatim
  (`AgentEvent`/`Entry` types, partial snapshots stripped); saku adds only what
  pi lacks (threads). Skills and prompt templates ride through the worker
  unmodified, hosted by the hub.
- **One deployment, two hosts** — the same worker and hub code ships to
  Cloudflare Workers (via alchemy) or a self-hosted celld fleet.

## Layout

| Package           | Role                                                                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/wire`   | the wire protocol: JSONL over WebSocket, hello/version, thread + session + skills commands, typed `WireClient` (an effect-machine actor) |
| `packages/store`  | the durability seam: the `KvStore` Effect service (the Durable Object storage contract) with memory, file, and DO storage backend layers |
| `packages/hub`    | the control-plane DO: registry, env provisioning (Box — incomplete, Freestyle planned), skills store, auth, routing, fan-out                              |
| `packages/worker` | the thread DO: pi-agent-core `Agent` + `Session` over DO storage, env client, idle-stop                                                 |
| `packages/env`    | the hands daemon: pi tool surface over a streaming protocol, local and in-VM                                                           |
| `packages/cli`    | local daemon management: `saku env start\|stop\|status`                                                                                 |
| `packages/deploy` | the deployment's own code: the alchemy program (`alchemy.run.ts`), the workerd DOs (`SakuHubDO`/`SakuThreadDO`), the celld twin (`celld/`) |

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
published URL and token from `~/.saku/`, verifies them with a wire handshake
probe, and only then hands them to the console (a killed daemon leaves a
stale URL file behind — the console never dials it). The app connects
straight to the worker (no deployed hub needed) and, while the daemon is
down, shows the offline state and polls the bootstrap — a restarted daemon
is picked up automatically, on its new port, without a page reload.
Quick-start a thread, and the prompt runs on the worker through the env
daemon — streaming back over the wire.

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
integration tests against it, including a full-stack suite that deploys the
stack to local workerd and drives it over the real wire (create → lazy env
provisioning → prompt → run in the thread DO → entries back, idle-stop through
the DO alarm, relay register/attach/exec, `delete_thread` teardown).

## CI

`.github/workflows/ci.yml` runs on every push and PR: setup (Node 26, pnpm,
bun), `pnpm typecheck`, `pnpm lint`, `vp fmt --check`, `pnpm test`, `pnpm
build`. The deploy tests exercise the real stack in local workerd (ephemeral
ports, `SAKU_FAKE_MODEL`), so CI needs no cloud credentials.

## Deploying

The deployment lives in `packages/deploy` (the same code both hosts ship):

- **Cloudflare** (production): `bun alchemy deploy` with the secrets as env
  vars — `BOX_API_KEY` (Box provisioning — **incomplete**, ADR 0008),
  `FREESTYLE_API_KEY` (Freestyle provisioning, once the backend lands — the
  deployment fails loudly on `SAKU_ENV_PROVISIONER=freestyle` until then), and
  `SAKU_ENV_*` for the
  static-provisioner shape (a single configured env daemon instead of Boxes).
  Model credentials are separate: the local daemon reads pi's `auth.json` +
  `models.json`; a deployed worker resolves the opencode gateway's
  `OPENCODE_API_KEY` off its bindings (not declared by the program — add it
  as a deployment secret when prompts need a real model).
- **celld** (development/self-hosted): `celld deploy packages/deploy/celld
--bucket <s3-bucket>` with esbuild on PATH — the wrangler twin mirrors the
  same bindings; vars are plaintext in the fleet bucket (trust domain).

Details in `packages/deploy/celld/README.md`.

## Documentation

- [`CONTEXT.md`](./CONTEXT.md) — the vocabulary: threads, workers, hub, envs,
  relay, Freestyle, idle-stop, and the rest of the domain model.
- `docs/adr/` — architecture decision records (highlights: managed-agents
  spine with per-thread DO workers; cloud-primary with a celld twin; one env
  daemon for local and sandbox; Freestyle as the sandbox provider (Box
  incomplete); the wire is pi's vocabulary verbatim over
  WebSocket; pi-only; no approval gates; hub-hosted skills).
- `docs/style.md` — house style for the code.

## Conventions

Tooling conventions follow pi where it matters: skills, prompt templates,
sessions, settings — pi's own vocabulary and extension surface ride through the
worker unmodified. In the wire, pi's public types cross verbatim; saku adds
only what pi lacks (threads) — extend pi, never shim it.

`effect-machine` (0.17.1) is patched (`patches/effect-machine@0.17.1.patch`)
for effect 4 beta's `Schema.TaggedError` rename — re-check the patch on any
effect upgrade.
