# 0001 — Wire is pi's RPC protocol, extended, not a custom protocol

Saku's wire reuses pi's existing RPC vocabulary from `@earendil-works/pi-coding-agent` (`rpc-types.ts`: commands, responses, events, extension UI) rather than designing a fresh protocol. We add only the thread layer pi lacks: registry ops (`list_threads`, `create_thread`, `get_thread`), a `threadId` on every command, and attach/tail of the session log. Same JSONL framing, same unix-socket transport, same auth-token habit.

Marking **status: accepted** — the wire survives into the cloud era: when threads become Durable Objects, the transport swaps (unix socket → Worker/DO) and the vocabulary stays.

The rejected alternative — a bespoke Effect-Schema wire like `@rly/wire` — duplicates pi's event model, which is already the correct model for what a session _is_. Reusing it is a one-day head start but, more importantly, it makes pi upgrades land directly in every console instead of requiring re-mapping.

Note: pi-only (see ADR 0004) makes this workable. A multi-agent abstraction layer would force a lowest-common-denominator protocol, which would kill the deep integration this decision exists to preserve.
