# Architecture

Saku is a chat for pi coding agents built on amp's orb shape: **one durable
thread per agent**, hands where you choose, a web console over the whole
conversation. This document is the high-level tour — the cast, the wire, the
trail, the lifecycle, and what actually happens when you send a prompt.

The vocabulary lives in [`CONTEXT.md`](../CONTEXT.md); the decisions behind
the shape live in [`docs/adr/`](./adr/); how the code should be written is
[`docs/style.md`](./style.md).

## The shape

```
consoles                     hub                         worker                     env
┌────────────┐   wire    ┌──────────────┐    RPC     ┌──────────────┐  env proto  ┌──────────────┐
│ foldkit    │ ◀═══════▶ │  hub core    │ ─────────▶ │ session host │ ◀══════════▶ │  env daemon  │
│ frontend   │  JSONL/WS │  registry    │   fetch    │  pi Agent +  │  (direct or │  LocalEnv    │
│ CLI        │           │  provisioner │            │  Session     │    relay)   │  (pi tools)  │
└────────────┘           │  idle-stop   │            │  on the trail│             └──────────────┘
                         └──────────────┘            └──────────────┘
```

Four roles:

- **Consoles** — the foldkit frontend and the CLI. They hold no state: they
  list, attach, tail, and command. A console crash loses nothing.
- **Hub** — the control plane, one per deployment (a Durable Object, or the
  local daemon). Owns the thread registry, provisions envs, routes wire
  commands, fans events out, and runs the idle-stop policy.
- **Worker** — one per thread (a Durable Object, or an in-process host). The
  brain: pi-agent-core's `Agent` + `Session` over durable storage.
- **Env** — the hands: a daemon running pi's tool surface
  (`read`/`bash`/`edit`/`write`) against the thread's workspace — on your
  machine or in a sandbox VM. The worker never knows which.

Two bets carry the design:

1. **The agent process is disposable.** Everything a worker needs survives
   restarts because state lives in an append-only entry trail, never in
   process memory. Recovery is replay, not a crash policy.
2. **Consoles are disposable too.** They never own session state; the wire is
   a projection of pi's own session model (ADR 0005 — extend pi, never shim
   it), plus one thing pi lacks: threads.

## The cast, in detail

| Role       | Runs where                                           | Holds                                                      | Rebuilt by                            |
| ---------- | ---------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------- |
| Console    | browser / terminal                                   | nothing                                                    | —                                     |
| Hub        | one DO per deployment (`"hub"`), or the local daemon | thread registry, skills store, env handles                 | DO storage / files                    |
| Worker     | one DO per thread, or an in-process host             | the session trail (entries), a record copy, the env handle | replaying the trail                   |
| Env daemon | your machine, or a sandbox VM                        | nothing durable                                            | hub provisioning (lazy, on first use) |

The deployment details (which DO, which RPC surface, which provisioner) are
in [Two hosts, one codebase](#two-hosts-one-codebase); the seam between the
two hosts is the subject of the next section.

## The wire: the control plane

One protocol, `@saku/wire`, spoken by every console against the hub (or,
transitionally, the local daemon): **JSONL frames over a single WebSocket**,
versioned (`hello`/`hello_ok` handshake with `WIRE_VERSION`), authenticated
with a shared deployment secret.

Three frame kinds:

- **`command`** — console → server. Session commands carry a `threadId`;
  hub-level commands (threads, skills) don't. Routing is stateless: the
  server dispatches on the frame alone.
- **`response`** — correlated by request id; every command gets exactly one
  `ok`/`error` reply.
- **`event`** — server → every connected console (fan-out; there is no
  attach/detach). Session events stream live activity; `thread_changed`
  broadcasts registry mutations with the full `ThreadInfo`.

The wire's session vocabulary is **pi's own, verbatim** (ADR 0005):
`AgentEvent` and `Entry` cross the wire as-is, with pi's shell projection
applied — cumulative `partial` snapshots stripped, `agent_end` replaced by
saku's `settled`. Saku adds only the thread layer (`create_thread`,
`get_entries`, `branch`, …). Because consoles are stateless, a console that
reconnects catches up with `get_entries {sinceSeq}` — no server-side replay.

The same connection core serves three servers:

- the **local daemon** (`worker/src/daemon.ts`) — a node WebSocket server
  that serves the full wire itself, the transitional local spine;
- the **hub's node server** (`hub/src/server.ts`) — the wire server adapted
  to `ws` sockets;
- the **hub DO** (`deploy/src/hub-do.ts`) — the same core adapted to workerd
  sockets at `/ws`.

The hub core itself (`hub/src/hub.ts`) is deliberately transport-free: it
answers domain calls and pushes `HubEvent`s to subscribers; each host adapts
it to its sockets.

## The relay: the data plane

The env protocol flows **worker ⇄ env daemon**, and for a daemon on your
machine it must cross the network without your machine opening any ports. The
hub's relay is the outbound bridge:

- the env daemon **dials the hub** and registers with `relay_hello {envId,
token}`;
- a worker's `RemoteEnv` **attaches** with `relay_attach {envId, token}`;
- the hub **pipes the two sockets** — everything after those frames flows
  through uninterpreted; the hub never parses the env protocol. Either side
  dropping closes the pipe.

A worker that attaches before its daemon has registered is held briefly with
its frames buffered (a grace window for daemon reconnects). Sandbox envs skip
the relay entirely: the worker connects to the VM's `host --private` URL
directly.

## Durability: the trail

All durable state rides one seam, `@saku/store`'s `KvStore`: an Effect
service whose backends are chosen at the composition site —

| Backend                      | Where                                            |
| ---------------------------- | ------------------------------------------------ |
| `KvStore.memory()`           | tests, in-process hosts                          |
| `KvStore.file(fs, root)`     | the local spine (atomic tmp+rename writes)       |
| `KvStore.doStorage(storage)` | the hub DO and thread DOs (Cloudflare and celld) |

Values are opaque bytes under forward-slash keys; writes are individually
atomic — a crash leaves a prefix of the log, which is exactly what the
session storage's replay expects.

What lives where:

- **Hub DO storage** — the thread registry (id → name, cwd, mode, env axis,
  tailSeq, provenance) and the skills store.
- **Thread DO storage** — the thread's record copy, its env handle, and the
  **session trail**: the append-only entry log of messages, tool calls,
  model changes, and compactions, written by pi's session machinery through
  the same `KvStore` seam.

The trail is the thread's identity: any restart — a crash, a migration, a new
host — rebuilds the worker from it. **The DO is disposable; the thread is
not.**

## The worker: pi hosted

Each thread's worker is a `SessionHost` (`worker/src/session-host.ts`), the
server-side analogue of pi's shell `AgentSession`, built directly on
pi-agent-core's `Agent` + `Session`:

- the **trail** lives on `KvStore` through a `DoSessionRepo`;
- on creation it opens (or recreates) the DO session, recovers the durable
  values — model, thinking level, name — from the entry trail, restores the
  live transcript into the agent, and spawns a run machine;
- the host is an **effect-machine actor**: `Idle ⇄ Working`, plus
  `Interrupted` (an operation was left open in the trail — recovered on first
  touch), `Compacting` (a manual compaction in flight), and `Crashed`
  (host-local; the next command rebuilds from the trail).

Two lifecycle rules keep the system cheap:

- **Lazy hosts.** A thread builds its host on the first _mutating_ command;
  the read-only commands (`get_entries`, `get_state`,
  `get_available_models`, `get_available_thinking_levels`) are served from
  the registry/catalog alone when no session has started. Browsing a thread
  is free, and a stopped sandbox stays stopped until a prompt (ADR 0004).
- **State is a channel, not a secret.** Every state push is broadcast as
  `thread_changed`, so any console can render the thread's liveness without
  owning it.

## The env: the hands

The env daemon (`packages/env`) is one binary, one protocol (`protocol.ts`),
both transports:

- the local WebSocket server (`EnvDaemon.make`) — loopback, or behind a
  Box's `host --private` URL;
- the outbound relay socket (`EnvRelayClient.make`) — dials the hub so a
  daemon behind NAT becomes reachable.

Every connection opens with `env_hello {token, version, cwd?}` — the `cwd`
fixes the workspace the connection's tools operate on (a worker connects once
per thread with the thread's workspace). Then pi's file/shell surface runs as
request/response frames: `read`/`write`/`edit` ops answer with results or
pi's own error classes; `exec` streams stdout/stderr as `env_stream` frames
and an `env_abort` frame kills the process.

The worker side is `RemoteEnv`, which implements pi's `ExecutionEnv` promise
contract on the client end of the same protocol. Errors cross as pi's own
`FileError`/`ExecutionError` classes, reconstructed at the boundary — **a
remote env fails exactly like a local one**, which is why the worker code
never needs to know which it's driving.

## Lifecycle

**Mode is pinned at creation.** A thread's hands policy (`local` / `sandbox`
/ `any` — local preferred, sandbox fallback) is hard-pinned because switching
mid-thread changes which filesystem the hands see. The pin is the thread's
identity.

**Two state axes, deliberately separate.** A thread can be `working` while
its env is `ready` — or `idle` while its env is `stopped` (idle-stop; the
next prompt provisions it again).

- Thread axis: `idle` / `working` / `interrupted` — derived by the worker,
  broadcast on change.
- Env axis: `stopped` / `provisioning` / `ready` / `error` — owned by the
  hub, part of `ThreadInfo`.

**The env gate.** Every non-read-only command passes through `ensureEnv`
first: if the env isn't `ready`, the hub provisions (or resumes) it, hands
the worker an **env handle** (URL + token + relay identity), and flips the
axis. A worker that restarted since provisioning gets its persisted handle
re-pushed. A provisioning failure flips the axis to `error`; the next prompt
retries.

**Idle-stop.** Sandbox envs are expensive while running, so the hub arms an
idle window whenever a sandbox thread is idle with a ready env, and disarms
on any activity. In the deployment the timer is a **durable DO alarm** armed
in the thread DO (`/arm-idle`); when it fires, the worker pushes
`idleStopFired` to the hub, which validates, releases the env, and flips the
axis. Local envs never stop. Default window: 5 minutes.

**Quick start and auto-title.** A quick start creates a thread named from the
first prompt and sets it working in one gesture. After the thread's first
settled run the worker reports an LLM-generated title, which the hub applies
only while the name is still auto-generated — a user rename wins forever.

**Adoption.** Pi session files on the user's machine can be imported through
the local daemon: the file is read once through pi's own semantics and
replayed into the thread's own trail; the source file is never written, and
the record's provenance pins where it came from (re-import is idempotent).
Only the local daemon serves this — the hub has no `~/.pi`.

## End to end: a prompt

### On the local spine

```
console ──prompt──▶ daemon ──registry lookup──▶ hostFor: build SessionHost
                       │                          (open trail, recover, LocalEnv hands)
                       ▼
                  session machine: Working ──▶ pi Agent runs
                       │                          │ tool calls
                       ▼                          ▼
                  agent events ──entry_appended──▶ trail (file KV)
                       │                          │ LocalEnv: bash/read/edit/write
                       ▼                          ▼
                  broadcast ──event──▶ console   stdout streams back
```

`daemon start` boots the worker daemon (registry + per-thread hosts over
file-backed KV, hands in-process via `LocalEnv`); `env start` boots the env
daemon for the local-mode hands protocol. The console connects straight to
the daemon — no hub needed.

### Deployed

```
console ──prompt──▶ hub DO (/ws) ──env gate: provision──▶ provisioner
                       │                                      (Box / static / Freestyle)
                       ▼
                  registry lookup ──▶ thread DO (/command)
                       │
                       ▼
                  SessionHost builds: RemoteEnv connects
                       │             (relay_attach, or direct to VM)
                       ▼
                  pi Agent runs ──tool calls──▶ relay pipe ──▶ env daemon on your machine
                       │                                           (or the sandbox VM)
                       ▼
                  events + reports ──/push──▶ hub ──fan-out──▶ every console
```

The hub is the single address behind the deployment's domain. `/ws` serves
consoles, `/relay` serves env daemons, `/push` is the thread DOs' JSON
channel (reports, session events, idle-stop firings).

### Crash recovery

1. A thread DO dies mid-run — say, the platform recycles it.
2. The next command hits the DO fresh; `runCommand` builds the host from the
   trail: the open operation in the log marks the thread `Interrupted`.
3. The host recovers model/thinking-level/name from the trail, restores the
   transcript, and the command proceeds. No state was lost — the run's
   outcome may have been, but the conversation never is.

## Two hosts, one codebase

The same wire protocol, the same DO classes, two hosts:

|                   | Local spine                                                         | Deployment                                     |
| ----------------- | ------------------------------------------------------------------- | ---------------------------------------------- |
| Hub role          | the worker daemon (transitional)                                    | `SakuHubDO`, one per deployment                |
| Worker role       | in-process `SessionHost` per thread                                 | `SakuThreadDO`, one per thread                 |
| Storage           | file-backed `KvStore` under `~/.saku/`                              | DO storage                                     |
| Hands             | in-process `LocalEnv`                                               | `RemoteEnv` over the relay or a remote machine |
| Console bootstrap | `/__saku` reads `~/.saku/worker.url` + token, probes, then connects | same-origin `/ws` on the deployment's domain   |

The daemon is the transitional local spine: when the hub owns the wire's
server side in production, the daemon keeps the local stack alive speaking
exactly the same protocol — the wire is the integration seam the whole system
is verified against (unit, integration, and full-stack tests over local
workerd).

The deployment's DO classes are **plain workerd** — no alchemy runtime in the
entry bundle — so the same code ships to Cloudflare (`bun alchemy deploy`)
and the celld twin (`packages/deploy/celld`). The thread DO's RPC surface is
`/create` `/command` `/set-env-handle` `/arm-idle` `/disarm-idle` `/delete`;
its durable alarm is the idle-stop trigger.

Sandbox provisioning is behind the `SAKU_ENV_PROVISIONER` switch: `static`
(the default; one configured env daemon — dev/celld shape), `box` (ascii.dev —
explicit parity opt-in, **incomplete**, ADR 0008), `freestyle` (the provider
of record, ADR 0008 — fails loudly until the backend lands). Unknown values
fail rather than silently selecting Box (ADR 0010).

## The seams

Every seam has two or three implementations, chosen at the composition site:

| Seam            | Implementations                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------- |
| `KvStore`       | memory · file · DO storage                                                                         |
| Wire server     | daemon · hub node server · hub DO (`/ws`)                                                          |
| Env transport   | local socket · relay socket · provider endpoint                                                    |
| Env provisioner | local relay path · static daemon · remote-machine adapters (Box/Freestyle)                         |
| Idle-stop timer | hub-side timers (local spine, tests) · DO alarm (deployment)                                       |
| Worker ref      | thread-DO namespace (deployment) · scripted (tests) · absent (local spine — the daemon is the hub) |
| Socket          | node `ws` · workerd `WebSocket` (same `SocketLike` surface)                                        |

## Where to look next

- [`CONTEXT.md`](../CONTEXT.md) — the vocabulary: threads, workers, hub,
  envs, relay, idle-stop, and the rest of the domain model.
- `docs/adr/` — the decisions behind the shape (managed-agents spine,
  cloud-primary with a celld twin, one env daemon for local and sandbox,
  the wire, pi-only, no approval gates, hub-hosted skills, Freestyle).
- `docs/style.md` — house style for the code.
- [`README.md`](../README.md) — features, layout, running, deploying.
