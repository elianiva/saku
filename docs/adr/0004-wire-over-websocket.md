# 0004 — The wire: pi's vocabulary verbatim, over WebSocket JSONL

Status: accepted

## Context

The original wire was JSONL over a unix socket — right vocabulary, wrong transport for a browser frontend and a cloud hub. The standing rule survives: **extend pi, never shim it** — pi's public types cross verbatim; saku adds only what pi lacks (threads).

## Decision

The wire is JSONL frames over a single **WebSocket** per console, terminated at the hub's domain. `hello`/`hello_ok` handshake with `WIRE_VERSION`; a shared deployment secret authenticates consoles (v1 is single-owner; passkeys/accounts belong to the frontend pass).

Surface (working-first; additive later):

- Thread ops: `list_threads` · `create_thread {name, mode, autoName, cwd?}` · `get_thread` · `rename_thread` · `delete_thread`
- Session: `prompt` · `steer` · `follow_up` · `abort` · `compact` · `set_auto_compaction` · `set_model` · `set_thinking_level` · `set_steering_mode` · `set_follow_up_mode` · `branch` · `set_session_name`
- Reads: `get_entries {sinceSeq}` · `get_state` · `get_available_models` · `get_available_thinking_levels` · `get_session_stats`
- Skills: `list_skills` · `import_skill` · `delete_skill`
- Events: pi's `AgentEvent` minus `agent_end` (replaced by `settled`) with partials stripped, plus `entry_appended`, `compaction_start/end`, `thread_changed` (carries full `ThreadInfo` incl. env status), `error`.

TUI-shaped sugar dies (`cycle_model`, `cycle_thinking_level`, `get_messages`, `get_last_assistant_text`, `get_tree`); reads never start a session, so browsing is free and a stopped Box stays stopped until a prompt.

## Consequences

- One protocol for the frontend, the CLI, and tests — the wire is the integration seam the whole system is verified against.
