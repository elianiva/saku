# 0002 — Local-first: a worker daemon now, a durable-object brain later

Status: accepted

## Context

The long-term architecture is a cloud control plane: one Durable Object per
thread, sessions in DO storage, sandboxed remote hands, durable execution
independent of any client. That is not what v1 builds. v1 is a worker
daemon on the user's machine hosting threads locally, with the TUI and CLI
as consoles.

## Decision

The cloud shape is preserved as **seams**, not implemented as features:

1. **Storage seam** — the worker persists sessions through
   `JsonlSessionRepo` from pi-agent-core over a small `ExecutionEnv`
   interface (`LocalEnv` today). A DO-backed repo is a second
   implementation of the same interface.
2. **Transport seam** — the wire protocol (ADR 0001) is transport-agnostic
   JSONL. Today: unix socket + auth token. Later: WS / DO fetch — the
   frames and vocabulary stay.
3. **Hands seam** — execution happens behind the thread's `mode` (only
   `local` exists today). A sandbox provider is a future second
   implementation of the same contract.
4. **Model catalog seam** — models come from pi-ai's built-in providers
   plus the user's `auth.json`/`models.json`, composed through
   `getApiProvider`. No network refresh, no extension providers — v1 reads
   what pi itself reads.

The durable-object brain is intentionally not being built now. It is not an
MVP dodge: it is the correct ordering — prove the protocol, the worker, and
the console UX locally, then lift storage, transport, and hands into the
cloud once the shape is proven.

## Consequences

- Everything is local and hermetic: `SAKU_HOME` overrides the whole
  `~/.saku` layout, so tests and smoke runs never touch the user's home.
- The daemon is a single process; there is no distributed-state machinery
  to debug in v1.
- When the brain arrives, the wire vocabulary survives; only the transport
  and storage implementations swap.
