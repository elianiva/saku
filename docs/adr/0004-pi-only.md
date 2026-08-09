# 0004 — Pi only: no generic agent abstraction

Status: accepted

## Context

Should saku define a `Harness`-style abstraction so other agents (ampcode,
opencode, …) could plug in later? Or integrate pi and pi alone?

## Decision

Saku integrates pi only. No adapter layer for future agents, no
lowest-common-denominator event model, no `Harness` interface.

Rationale: deep integration beats breadth. The wire protocol (ADR 0001) is
a projection of pi's session model — entries, lanes, compaction, forks,
extension UI. Any tailoring for a hypothetical second agent would abstract
away the exact detail that makes consoles thinkable: the TUI renders
durable entries, model changes, and compaction history because the
protocol speaks pi's model natively. A generic layer would reduce every
console to a chat view.

Concretely, the worker builds on **pi-agent-core's `Agent`, `Session`, and
compaction** — the same pieces pi's own shell composes — not on pi's app
shell, its RPC mode, or its extension system. We make our own
wire/worker/consoles on top of the core.

## Consequences

- pi upgrades land directly (see ADR 0001); the wire package re-exports
  pi's types at the only typed door consoles see.
- This is a feature, and it is revisitable: if a second agent ever becomes
  a real need, the cost is protocol extension, not a rewrite — the seams
  in ADR 0002 (transport, storage, hands) are agent-agnostic.
