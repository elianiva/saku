# 0001 — The managed-agents spine: a gateway hub with per-thread DO workers

Status: accepted

## Context

The original local spine ran one daemon process hosting all sessions in-process over a unix socket. The target shape — inspired by Anthropic's managed-agents architecture and amp — decouples the **brain** (the agent loop) from the **hands** (the execution environment) and makes the session a durable, restartable object.

## Decision

The system is a spine of three layers, connected by two seams:

```
frontend ⇄ hub ⇄ worker ⇄ env
```

- **Worker**: one Durable Object per thread (Cloudflare Workers or celld), hosting pi-agent-core's `Agent` + `Session` over a DO-storage-backed session repo. All state lives in the entry trail — a worker is disposable and rebuilt from its trail on any restart. Sessions start lazily: read-only commands never create one.
- **Hub**: the control-plane DO, one per deployment — owns the thread registry, provisions envs, creates workers through the DO namespace, authenticates consoles, routes wire commands, and fans events out. The single entry point behind the deployment's domain.
- **Env**: the hands provider (see ADR 0003) — always remote from the worker.

Thread state shrinks to `idle | working | interrupted`; `crashed` is gone (a failed command is an error response; the next command rebuilds from the trail). Env availability is a separate axis on `ThreadInfo` (`stopped | provisioning | ready | error`).

## Consequences

- A thread survives any worker death: recovery is replaying the trail, not a crash policy.
- The hub is the single point of failure for the control plane — but it is stateless routing plus a registry, and its own state lives in DO storage.
- The wire keeps the property that consoles are stateless: commands carry `threadId`, events fan out, consoles catch up with `get_entries {sinceSeq}`.
