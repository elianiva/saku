# 0003 — The env is remote and uniform: one env daemon, Box as the sandbox

Status: accepted (sandbox-provider axis superseded by ADR 0008 — Box is incomplete;
Freestyle is the intended provider; the env-daemon seam and idle-stop policy stand)

## Context

pi-agent-core's only Node-boundary is its execution env (`harness/env/nodejs`); its core and its `SessionRepo`/`SessionStorage` abstractions are isolate-clean. That makes the managed-agents split physically possible: the worker never executes anything; the env does.

## Decision

- **One env daemon** (one binary, one streaming protocol) executes the pi tool surface (`read`/`bash`/`edit`/`write`) against a thread's workspace. It runs on the user's machine (`mode: local`, registered with the hub via outbound relay) or inside a **Box** (`mode: sandbox`, exposed via `host --private`). The worker holds an opaque `EnvHandle` (URL + token) and never knows which host it is.
- **Box (ascii.dev) is the sandbox provider** — not Cloudflare Sandbox. One Box per thread, lazily provisioned by the hub on first use, created `--no-auto-stop` (Box's built-in TTL counts from creation and fires mid-work — useless for us), first-party credentials, empty workspace (the agent clones its own repos; `gh` is preinstalled and authenticated). *(Incomplete — superseded by Freestyle, ADR 0008.)*
- **Control plane through the hub, data plane direct**: the hub owns the Box API key and all lifecycle calls; the worker talks straight to the env daemon.
- **Idle-stop**: the worker arms a per-thread DO alarm when the thread is idle; after 5 minutes without activity (no run in flight, no commands, no events) the hub stops the Box (snapshot, billing paused). The next prompt resumes it (seconds). Local envs never stop. A generous backstop TTL on the Box is kept as insurance against a dead worker.

## Consequences

- Tool calls stream through the daemon (Box's one-shot `commands`/`files` API remains the bootstrap channel only — install/start the daemon, heartbeat, fallback).
- A stopped Box is the normal resting state of an idle sandbox thread; consoles see it on the `env` axis of `ThreadInfo`.
