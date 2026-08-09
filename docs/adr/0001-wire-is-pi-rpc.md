# 0001 — The wire extends pi, it never shims it

Status: accepted

## Context

Consoles (TUI, CLI) talk to the worker over a unix socket. The protocol
needed to carry pi's entire session vocabulary — prompts, entries,
compaction, model state — plus a small registry layer pi doesn't have
(threads). Two paths existed: design a bespoke wire of our own, or carry
pi's types across the wire as-is and add only what's missing.

## Decision

Saku's wire carries pi's public vocabulary **verbatim**: `AgentEvent`,
`Entry`, `SessionStats`, and friends cross the wire in their original
shapes, and pi's commands (`prompt`, `steer`, `get_entries`, `compact`,
`get_state`, …) are preserved by name and semantics. Consoles import these
types from `@saku/wire`, which re-exports them from pi-agent-core — never
re-schematized, never renamed, never re-serialized.

What saku adds is only what pi lacks:

- the **thread layer**: `create_thread`, `list_threads`, `get_thread`,
  `delete_thread`, thread state (`idle | working | crashed | interrupted`),
  and `thread_changed` events;
- the **`settled` event** replacing pi's `agent_end` (the durable log is
  the source of truth, so end-of-run carries no payload);
- **`entry_appended`**, `compaction_start`, `compaction_end`, `error`
  events, and the `get_entries { sinceSeq }` catch-up command;
- `message_update` events with the cumulative `partial` snapshot stripped
  (the projection pi's own shell ships to its UIs).

pi's RPC machinery (`runRpcMode`, `RpcClient`, the extension system) is
explicitly **not** the wire's substrate. The worker is a server-side
`AgentSession` built directly on pi-agent-core, and the wire is our own
JSONL protocol with pi's vocabulary inside.

## Consequences

- A pi upgrade lands in every console the day it lands in the core — no
  re-mapping layer to maintain.
- Consoles never import pi packages directly; `@saku/wire` is the single
  typed door, which keeps the wire package publishable and testable on its
  own.
- The protocol is ours to version (see `version.ts`), so the thread layer
  can evolve without forking pi.
