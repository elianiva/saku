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

| Package           | Role                                                                                                                                                                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/wire`   | Rework: the protocol — JSONL over WebSocket, hello/version handshake, thread/session/skills commands, typed `WireClient` (browser-compatible; the client is an `effect-machine` actor — connection lifecycle as a schema-first state machine). Zero pi imports at runtime for framing; pi's public types cross verbatim. |
| `packages/store`  | The durability seam: `KvStore` (the Durable Object storage contract — `get`/`put`/`delete`/`list`) with its memory and file implementations, plus the shared `isNotFound` helper. Used by the hub (registry, skills store) and the worker (session trail); DO adapters implement it trivially.                           |
| `packages/hub`    | New: the control-plane DO — registry, Box provisioning (owns Box keys), skills store, auth (deployment secret), WS routing, event fan-out.                                                                                                                                                                               |
| `packages/worker` | Rework: the thread DO — `SessionHost` ported onto a DO-storage `SessionRepo`, env data-plane client, idle-stop alarm, event projection.                                                                                                                                                                                  |
| `packages/env`    | New: the hands daemon — pi tool surface (`read`/`bash`/`edit`/`write`) over a streaming protocol; local host (relay registration) and Box host (`host --private`).                                                                                                                                                       |
| `packages/cli`    | Slim: `saku env start                                                                                                                                                                                                                                                                                                    | stop | status` only (local daemon management). |

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

- **M0 — wire** ✅: WS transport, handshake, command/event schemas, typed client
  (`makeWireClient` as an effect-machine actor), 19 integration tests against a
  mock hub.
- **M1 — worker on DO storage** ✅: `SessionRepo`/`SessionStorage` over the
  `KvStore` seam (`DoSessionRepo`/`DoSessionStorage` — pi's own backend
  conformance suite passes against both the memory and file backends), the
  `SessionHost` ported from a class to an effect-machine actor
  (Idle/Interrupted/Working/Compacting/Crashed; commands are reply-bearing
  calls settled by the state-scoped run effects), idle/interrupted recovery,
  and a stub env for hermetic host tests (79 worker tests). The local daemon
  now serves the wire from the file-backed trail; verified live
  (create → set_model → get_state/get_entries → rename → delete, and
  restart persistence). The env data plane stays a seam: `ExecutionEnv`
  (LocalEnv locally, the remote client in M3).
- **M2 — hub** ✅: `packages/hub` — the control-plane core (`makeHub`:
  durable registry over the `KvStore` seam with the persisted env axis,
  worker seam (`ThreadWorkerRef` — create/delete/command/close, events and
  reports pushed back through the `HubEventSink`), env provisioner seam
  (`localOnlyProvisioner` for M2 — sandbox provisioning lands with M3),
  hub-hosted skills store, read-only commands bypassing the env gate), the
  wire server (`makeHubServer`: hello/version auth, stateless routing,
  fan-out), and 34 tests: core suites with a scripted worker, full wire
  integration over real WebSockets with multiple consoles, and the
  real-SessionHost stack (in-process worker ref wrapping the actual
  `SessionHost` — lazy sessions, streamed runs, sessionId back-fill,
  auto-title reporting, trail deletion).
- **M3 — env daemon** ✅: `packages/env` — the hands of the spine. The
  env protocol (hello/version, pi's `ExecutionEnv` surface verbatim,
  streamed `exec`, abort, error classes), the daemon (`makeEnvDaemon`,
  token-gated WS, one `LocalEnv` per connection workspace), `RemoteEnv`
  (the worker's `ExecutionEnv` over the wire), the relay client
  (outbound registration, reconnect loop), and the Box bundle
  (`tsdown.bundle.config.ts` → `dist/entry.bundle.js`, one self-contained
  file the provisioner uploads). The hub grew: the Box API client
  (`makeBoxApi`, injectable fetch), the real provisioner (`makeProvisioner`
  — lazy create, bootstrap via the one-shot commands/files API, systemd
  unit + `host --private` wrapper, health probe before `ready`, resume
  with URL re-read), the relay server (`makeHubRelay` — register, attach,
  pipe, with frame buffering for attach-before-register), the persisted
  `EnvHandle` on the registry, and idle-stop (arm on idle / disarm on
  activity / fire → release → env `stopped`, broadcast). The CLI is
  `saku env start|stop|status [--hub]` — the daemon spawn, identity in
  `~/.saku/env.json`, status probed over the env protocol. 156 tests
  (10 env, 48 hub incl. provisioner/relay/idle-stop over real sockets,
  78 worker incl. the real SessionHost over RemoteEnv — the agent's
  `bash` executes on the daemon and its stdout lands in the trail);
  live-verified: the built bundle serves the tool surface, and the CLI
  lifecycle works end to end.
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
- M3 serves the relay on its own WebSocket port (the wire server and the relay
  server are separate); the alchemy DO adapter (M4) multiplexes both behind the
  single domain.
- M3 hosts the idle-stop timer in the hub (armed on idle worker reports, reset by
  activity); the worker DO alarm of M4 replaces the timer, same semantics — the
  ADR's "the worker arms, the hub pulls" is preserved.
- Local threads still use the in-process `LocalEnv` in the transitional daemon;
  the relayed local env (a cloud worker driving the user's machine through the
  hub) is exercised by tests and lands with the DO worker in M4.

## 11. Verification items (not blockers)

- celld DO → host-loopback reachability for `mode: local` when the hub runs on celld.
- alchemy's celld target maturity.
- Box `host --private` URL stability across stop/resume.
- Cloudflare DO namespace deletion behavior for thread husks.
