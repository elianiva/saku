# Plan 0001 — The local spine (wire · worker · cli · tui)

Status: implemented — the spine is built and verified end to end
(`packages/worker/smoke.ts`). `saku run` (headless console) remains
deferred; CLI is the daemon steward only.

The local control plane: a daemonized worker that hosts one pi session per
thread, a wire protocol on top of pi's own vocabulary, and the TUI/CLI
consoles. No cloud, no sandboxes, no GUI — those stay sealed behind seams
(ADR 0002).

---

## 1. Architecture in one paragraph

The worker is a **supervisor process** (the daemon) hosting **in-process
`SessionHost`s** — one per thread, built on pi-agent-core's `Agent`,
`Session`, and compaction (ADR 0005). A thread is a durable entry trail
under `~/.saku/threads/<id>/`; model/thinking/interrupted state is
recovered from the trail. Consoles (TUI, CLI) are JSONL clients over a
unix socket; the wire carries pi's vocabulary verbatim plus a thin thread
registry layer (ADR 0001). Everything runs on Node (type-stripped TS),
Effect, and pi-agent-core.

## 2. Packages

| Package | Role |
|---------|------|
| `packages/wire` | The protocol: framing, handshake, thread/session commands, typed `WorkerClient` with reconnect, and pi-type re-exports. Zero pi imports at runtime for framing. |
| `packages/worker` | The daemon: auth, registry, model catalog (pi-ai providers + user `auth.json`/`models.json`), `SessionHost`, `SessionStorage` over `LocalEnv`, socket server. `@saku/worker/daemon` is the entry. |
| `packages/cli` | Daemon steward (`daemon start/stop/status`) + thread ops (`list`, `new`, `open`, `rm`); auto-starts the daemon on demand. `saku run` deferred. |
| `packages/tui` | The console: foldkit TEA app on foldtui — thread list, thread view, dialogs, reconnect catch-up. |
| `packages/foldtui` | The terminal renderer: foldkit view trees → OpenTUI renderables, mouse clicks, keyboard translation (`OnKeyDown`/paste), subscriptions. In-repo, renderer-dumb, no saku concepts. |
| `packages/demo` | The foldkit counter demo + its smoke (in-memory streams, scripted clicks). |

## 3. The wire protocol

One JSON object per line (`\n` framing). First line: `hello {token, role}`;
worker replies `hello_ok {pid, version}` or drops the socket. Then:

- commands: `{_tag, id, threadId?, …}` — thread ops (`list_threads`,
  `create_thread`, `get_thread`, `delete_thread`) and session commands
  (`prompt`, `steer`, `follow_up`, `abort`, `get_entries {sinceSeq}`,
  `get_state`, `compact`, `set_model`, `cycle_model`,
  `set_thinking_level`, `cycle_thinking_level`, `get_available_models`,
  `get_available_thinking_levels`, `get_tree`, `get_session_stats`,
  `set_session_name`, … — pi's vocabulary by name and semantics);
- responses: `response {id, ok, payload}`;
- events: `event {threadId, event}` — pi's `AgentEvent` verbatim minus
  `agent_end` (replaced by `settled`) and with `partial` stripped from
  `message_update`; saku's own `entry_appended`, `compaction_start/end`,
  `thread_changed`, `error`.

Routing is stateless: every command carries `threadId`, events fan out to
all consoles, consoles filter and catch up with `get_entries {sinceSeq}`.

## 4. The daemon

`~/.saku/` layout: `worker.sock`, `auth` (random 32-byte hex, 0600),
`worker.log`, `threads/<id>/{thread.json, sessions/}` (`SAKU_HOME`
overrides; `PI_CODING_AGENT_DIR` overrides `~/.pi/agent` for auth.json /
models.json).

Thread lifecycle: `idle → working → idle` per run; `crashed` on host
throw (rebuild on next command); `interrupted` derived from open
operations at first touch. SIGTERM/SIGINT shut down cleanly.

## 5. Console notes

- **CLI**: `saku daemon start|stop|status`, `saku list`, `saku new <name>
  [--cwd] [--mode]`, `saku open [thread]`, `saku rm <thread>`.
  Auto-start on demand; `open` spawns the TUI with `--experimental-ffi`
  (OpenTUI's native FFI requirement on Node).
- **TUI**: thread-list screen (cursor, new/delete dialogs, live updates
  from `thread_changed`), thread view (durable entries + live events,
  input box, model/thinking cycling, scroll-back, abort), error/confirm/
  input dialogs, and reconnect with catch-up.

## 6. Milestone status

- **M0 — wire package**: done (framing, handshake, envelopes, typed
  client, reconnect).
- **M1 — worker daemon + CLI core**: done; `smoke.ts` proves
  boot → handshake (good + bad token) → registry ops → read-only commands
  never starting a session → first message starting it → durable entries →
  error paths → clean shutdown, in a hermetic `SAKU_HOME`.
- **M2 — TUI + foldtui keyboard**: done (keyboard translation, paste
  slot, subscription seam, screens, dialogs).
- **M3 — polish**: docs rewritten (ADR 0001–0005, this plan), demo smoke
  on node, workspace typecheck/test green.

## 7. Deferred

- `saku run` (headless console: prompt → stream events → settled → exit).
- Wire-level unit tests (hermetic integration test with a stub streamFn
  after the spine proves itself in use).
- Extension-UI dialogs (`ui_respond`) — pi's own machinery, not yet wired.
- Auto-compaction tuning; `saku daemon status` thread counts; log rotation.
