# 0002 — Local-first: worker daemon now, durable-object brain later

The long-term architecture is a cloud control plane: one Durable Object per thread, sessions living in DO storage, sandboxed remote hands, durable execution independent of any client. That is **not** what we build now. v1 is deliberately minimal: a worker daemon on the local machine hosting threads, `mode: local` only, and `CLI`/`TUI` as consoles.

The cloud shape is preserved as seams, not implemented as features:

1. **Storage seam** — the worker uses pi's `SessionStorage` interface (`@earendil-works/pi-agent-core`). When the cloud arrives, a DO-backed `SessionStorage` implementation swaps in under the same harness.
2. **Transport seam** — the wire protocol defined in ADR 0001 is transport-agnostic (JSONL today). Workers/DO WS later.
3. **Hands seam** — execution happens behind the thread's `mode` (only `local` exists today). A sandbox provider is a future second implementation of the same contract.

Marking **decision: accepted** — the DO brain is intentionally not being built now. It is not an MVP dodge: it is the correct ordering (land the protocol + worker + console UX, then lift the storage/transport/hands up into the cloud once the shape is proven).
