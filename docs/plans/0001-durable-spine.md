# Plan 0001 — The durable spine (hub · worker · env · wire)

Status: planned — the design agreed in the rework grilling session. Supersedes the
local-spine plan; the TUI, foldtui, demo, and pty harness are removed.

The managed-agents shape: a **hub** (Cloudflare Workers, or celld locally) hosts one
**worker** (a Durable Object) per thread; each worker runs pi-agent-core's
`Agent` + `Session` over DO storage and drives a remote **env** — the user's machine
(local env daemon, outbound relay) or a **Box** (ascii.dev sandbox). Consoles
(foldkit frontend next; thin CLI now) connect over one **wire**: JSONL over WebSocket.

---

## 1. Packages

| Package | Role |
|---------|------|
| `packages/wire` | Rework: the protocol — JSONL over WebSocket, hello/version handshake, thread/session/skills commands, typed `WireClient` (browser-compatible; the client is an `effect-machine` actor — connection lifecycle as a schema-first state machine). Zero pi imports at runtime for framing; pi's public types cross verbatim. |
| `packages/hub` | New: the control-plane DO — registry, Box provisioning (owns Box keys), skills store, auth (deployment secret), WS routing, event fan-out. |
| `packages/worker` | Rework: the thread DO — `SessionHost` ported onto a DO-storage `SessionRepo`, env data-plane client, idle-stop alarm, event projection. |
| `packages/env` | New: the hands daemon — pi tool surface (`read`/`bash`/`edit`/`write`) over a streaming protocol; local host (relay registration) and Box host (`host --private`). |
| `packages/cli` | Slim: `saku env start|stop|status` only (local daemon management). |

Deleted: `tui`, `foldtui`, `demo`, `scripts/pty-drive.py`, foldkit patch. Root scripts
keep `typecheck`/`test`/`build`; `saku` remains the CLI entry.

## 2. The wire

JSONL frames over one WebSocket per console, terminated at the hub. `hello {token, role}` →
`hello_ok {pid, version}` or drop. Commands: thread ops (`list_threads`, `create_thread
{name, mode, autoName, cwd?}`, `get_thread`, `rename_thread`, `delete_thread`), session
commands (`prompt`, `steer`, `follow_up`, `abort`, `compact`, `set_auto_compaction`,
`set_model`, `set_thinking_level`, `set_steering_mode`, `set_follow_up_mode`, `branch`,
`set_session_name`), reads (`get_entries {sinceSeq}`, `get_state`, `get_available_models`,
`get_available_thinking_levels`, `get_session_stats`), skills (`list_skills`,
`import_skill`, `delete_skill`). Responses `response {id, ok, payload}`; events: pi's
`AgentEvent` verbatim minus `agent_end` (→ `settled`) and with `partial` stripped, plus
`entry_appended`, `compaction_start/end`, `thread_changed` (full `ThreadInfo`, incl.
`env` status), `error`.

Routing is stateless: every command carries `threadId`; the hub fans events out; consoles
filter and catch up with `get_entries {sinceSeq}`. Reads never start a session.

## 3. The hub

DO storage holds the registry: `id → {name, cwd?, mode, autoName, sessionId, tailSeq, env}`.
`create_thread` writes the record and creates the worker via the thread-DO namespace
binding; `delete_thread` removes the record, calls `deleteAll()` on the worker's storage,
and drops its alarm (the DO instance itself lingers as a husk — Cloudflare has no public
namespace delete).

Provisioning (Box only; local envs register themselves via outbound relay):
`ensureEnv` on first mutating command → create Box (`--no-auto-stop`, first-party env,
empty workspace, tagged with the thread id) → poll `ready` → install/start the env daemon
(bootstrap via the one-shot `commands` API) → hand the worker an `EnvHandle` (daemon URL +
token). Resume/stop go through the hub: idle-stop alarm fires in the worker → hub stops the
Box; next prompt → hub resumes, waits `ready`, waits for the daemon health check, then the
run proceeds. Backstop: a generous TTL on the Box, extended on activity.

Skills store: DO storage, `personal`/`workspace` scopes, records keep `source` + `version`.

## 4. The worker

The thread DO, constructed from pi-agent-core pieces:

- `SessionRepo`/`SessionStorage` implementation over DO storage (create/open/list/delete/
  fork + lanes + findOpenOperations) — the swap-in for `JsonlSessionRepo`. Entry trail in
  DO storage; model/thinking/interrupted recovery from the trail on every restart.
- The `SessionHost` logic ported from the current worker package: run lifecycle
  (working → settled → idle), auto-title, auto-compaction, model/thinking switching,
  branching, event projection. `crashed` state removed; a thrown command is an error
  response and the next command rebuilds.
- Env client: `execute(tool, args) → streamed result` against the `EnvHandle`; the tools
  are pi's harness tools adapted to the remote env (the current `tools.ts` adapter, with
  the env going over the wire instead of being pinned in-process).
- Idle-stop: DO alarm armed when idle, disarmed while working, reset on any command/event;
  fires → hub stop. Local envs: no lifecycle (no-op).
- Lazy: session created on first mutating command; reads answer from storage alone.

## 5. The env daemon

One binary, one streaming protocol (SSE or WebSocket, chosen during implementation —
the wire's framing habits apply). Exposes `read`/`bash`/`edit`/`write` + health. Local
host: `saku env start` launches it and registers with the hub over an outbound WebSocket
(relay); Box host: baked into the box template, started via systemd, exposed with
`host <port> --private`, bootstrapped through Box's `commands`/`files` API.

## 6. The CLI

`saku env start|stop|status` — manage the local env daemon (launch, register with the hub,
stop, status). Everything else is the wire's job, proven by tests.

## 7. Deployment

One alchemy program declares: the hub DO, the thread-DO namespace, the deployment secret.
Targets Cloudflare (production, domain-fronted) or celld (development/self-hosted, same
program). Box API key + LLM provider keys are deployment secrets.

## 8. Milestones

- **M0 — wire**: WS transport, handshake, command/event schemas, typed client.
- **M1 — worker on DO storage**: `SessionRepo` over DO storage, `SessionHost` port,
  env client; unit tests with a stub env (no Box needed).
- **M2 — hub**: registry, routing, fan-out, auth; integration tests over the wire
  (the user's call: tests, not a CLI smoke).
- **M3 — env daemon**: local host + relay registration; Box bootstrap via the one-shot
  API; idle-stop end to end.
- **M4 — deploy + docs**: alchemy program on celld, README, polish.

## 9. Deferred

- The foldkit frontend (next pass — the wire is its contract).
- Skills management UX (versioning, sharing, live reload), workspace admin push.
- Repo provisioning at thread creation; template boxes.
- Passkeys/accounts (v1 is a shared deployment secret).
- Box `desktop` (VNC) and preview URLs.

## 10. Notes

- `effect-machine` (0.17.1) is patched (`patches/effect-machine@0.17.1.patch`): its
  runtime still calls `Schema.TaggedErrorClass`, renamed to `Schema.TaggedError` in
  effect 4.0.0-beta.105+; the patch is a one-file rename. No shims elsewhere.

## 11. Verification items (not blockers)

- celld DO → host-loopback reachability for `mode: local` when the hub runs on celld.
- alchemy's celld target maturity.
- Box `host --private` URL stability across stop/resume.
- Cloudflare DO namespace deletion behavior for thread husks.
