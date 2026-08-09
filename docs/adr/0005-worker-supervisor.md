# 0005 — The worker is a supervisor with in-process sessions

Status: accepted

## Context

The original plan (0001-local-spine, first revision) ran one pi child
process per thread (`runRpcMode --session-dir …`), with the daemon as a
pure supervisor. Grilling exposed the costs: one Node process per thread
for idle sessions, a wire protocol that had to mirror pi's stdin/stdout
RPC mode, and console-side state for attach/tail. The question became:
where does the session actually live?

## Decision

One daemon process; sessions live **in-process**. The daemon holds one
`SessionHost` per thread — a minimal server-side driver built on
pi-agent-core's `Agent`, `Session`, and compaction (the same pieces pi's
own shell composes, minus the shell). Details:

- **Lazy hosts, later still: reads never start a thread.** A thread's
  session is created on the **first mutating command** (`prompt`, `steer`,
  `set_model`, `set_session_name`, …) — not at daemon boot and not on
  read-only commands (`get_entries`, `get_state`, model/thinking queries
  are served from the registry and catalog alone). Launching the TUI and
  browsing a thread therefore connects to the daemon without starting
  anything; the session begins when the user sends the first message.
- **Session id = thread id.** The persisted `JsonlSessionRepo` session
  (under `threads/<id>/sessions/`) uses the thread's uuid, so a thread
  survives daemon restarts with its full entry trail.
- **State lives in the entry trail.** Model, thinking level, and the
  interrupted state are recovered from entries (`model_change`,
  `thinking_level_change`, open operations on the `main` lane) when the
  host is created — no sidecar metadata.
- **Stateless routing.** Every wire command carries its `threadId`; there
  is no attach/detach, no server-side console registry. Events fan out to
  every connected console, and consoles filter. Reconnect catch-up is
  console-side: `get_entries { sinceSeq }` after reconnecting.
- **Crash policy.** A host that throws marks its thread `crashed`
  (`thread_changed` broadcast); the next command rebuilds it from the
  trail. No eager restart, no crash-looping.
- **Thread identity.** 8-char uuid prefix for humans; unambiguous-prefix
  matching; `delete_thread` removes host, registry record, and thread
  directory.

## Consequences

- A thread is idle-cheap (one object, no process), so `saku list` shows a
  factory's worth of threads without resource pressure.
- The wire protocol needed nothing beyond pi's vocabulary plus the thread
  layer (ADR 0001) — no child-process framing, no attach protocol.
- The daemon is the single point of failure for local sessions; its
  recovery story (lazy hosts + entry trail) is the mitigation, and the
  storage seam (ADR 0002) is where a cloud brain would later move it.
