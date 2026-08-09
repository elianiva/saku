# 0004 — Pi only: no generic agent abstraction

Saku integrates pi only. No adapter layer for future agents (no ampcode, opencode, or other harnesses), no `Harness` interface, no lowest-common-denominator event model.

Rationale: deep integration beats breadth. The wire protocol (ADR 0001) is a projection of pi's session model — entries, lanes, compaction, forks, extension UI. Any tailoring for a hypothetical second agent would abstract away the exact detail that makes consoles thinkable: the TUI can needless render session trees, forks, and tool state because the protocol speaks pi's model natively. A generic-layer would reduce every console to a chat view.

Marking **decision: accepted** — with the explicit note that this is a feature (revisitable). If a second agent ever becomes a real need, the cost is protocol extension, not a rewrite; the seams in ADR 0002 are agent-agnostic (transport, storage, hands).
