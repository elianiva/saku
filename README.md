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

| Package           | Role                                                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/wire`   | the wire protocol: JSONL over WebSocket, hello/version, thread + session + skills commands, typed `WireClient` (an effect-machine actor) |
| `packages/store`  | the durability seam: `KvStore` (the Durable Object storage contract) with memory and file backends                                       |
| `packages/hub`    | the control-plane DO: registry, Box provisioning, skills store, auth, routing, fan-out                                                   |
| `packages/worker` | the thread DO: pi-agent-core `Agent` + `Session` over DO storage, env client, idle-stop                                                  |
| `packages/env`    | the hands daemon: pi tool surface over a streaming protocol, local and in-Box                                                            |
| `packages/cli`    | local daemon management: `saku env start\|stop\|status`                                                                                  |

## Status

The durable spine's milestones through M3 are built and tested:

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

Remaining: the alchemy deployment on celld (M4) and the foldkit frontend —
see the plan.

## Prerequisites

- **Node ≥ 26** — source runs directly via type stripping, no build step (shipped
  code must therefore avoid `!` non-null assertions and constructor parameter
  properties, which strip mode rejects).
- **pnpm 11** — `packageManager` is pinned in `package.json`.

## Setup

```bash
pnpm install
```

There is no build step for development: everything runs from source. `pnpm build`
(tsdown) exists for packaging and is exercised by CI-style checks.

## Development

```bash
pnpm typecheck   # turbo: tsc --noEmit in every package
pnpm test        # turbo: vitest per package
pnpm build       # turbo: tsdown per package
```

The wire is the integration seam: the whole system is verified with unit and
integration tests against it (no CLI smoke; the frontend is the next consumer).

## Conventions

Tooling conventions follow pi where it matters: skills, prompt templates, sessions,
settings — pi's own vocabulary and extension surface ride through the worker
unmodified. In the wire, pi's public types cross verbatim; saku adds only what pi
lacks (threads) — extend pi, never shim it.
