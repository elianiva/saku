# Saku

A chat app for pi coding agents — a personal, cheaper take on amp's orb
architecture. A **hub** hosts one **worker** per thread; **consoles** (the
foldkit frontend, the scripting CLI) connect to it over one **wire** protocol.
Pi-only by design — no generic agent layer; the wire is a projection of pi's
own session model, so integration is deep rather than abstract. The long-term
shape — threads as durable objects, sandboxed remote hands — is the current
shape: workers are Durable Objects, hands are remote envs.

## Language

**Saku**:
The project itself. A chat app for pi coding agents: one thread, one agent
conversation, the full trail visible in the console. This monorepo is the
project (wire, hub, worker, env, cli).
_Avoid_: the-factory, control-plane, orchestrator

**Amp**:
The reference product (ampcode.com) whose orb architecture saku is a personal,
cheaper, rougher take on — one orb per thread: a remote machine joined to the
conversation, scale-to-zero, controllable from anywhere. Saku's shape is amp's;
the plumbing isn't. Saku is an experiment, not a competitor.
_Avoid_: calling saku "amp for pi" (the wire is pi-native, the deployment is Durable Objects — the resemblance is the shape, not the stack)

**Thread**:
The durable unit of agent work: a pi session plus registry metadata (name, cwd, `mode`, archive status). One thread is one **worker** — a Durable Object (Cloudflare or celld) — owning one session tree: the append-only log of messages, tool calls, and compactions. Everything a worker needs survives restarts because state lives in the entry trail, never in process memory.

Thread state is a channel every console can read without owning it: `idle` (no run in flight), `working` (a run or compaction is live), `interrupted` (a run was left open and was recovered at first touch — derived from the trail, never a boot scan). Transitions broadcast as `thread_changed` events.
_Avoid_: session (pi's word for the log machinery), task, job, run, conversation

**Worker**:
The per-thread execution pod: the Durable Object that hosts the thread's pi-agent-core `Agent` + `Session` over DO storage, projects wire events, and drives the thread's **env** over the data plane. Rebuilt from its trail on any restart — the DO is disposable, the thread is not. The seam where remote execution rendezvous.
_Avoid_: daemon (that's a lifecycle detail), server, backend, host

**Hub**:
The control-plane DO, one per deployment: owns the **registry**, provisions **envs** (creates/resumes/stops Boxes, registers the local env daemon), creates **workers**, authenticates consoles, routes wire commands, and fans events out. The single entry point behind the deployment's domain.
_Avoid_: gateway, server, backend, daemon

**Session**:
The pi agent session inside a thread — the machinery that owns a message tree (entries, lanes, compaction, forks) and speaks pi-agent-core's event vocabulary (`AgentEvent`, stripped of partial snapshots). A thread wraps exactly one session.
_Avoid_: conversation, log

**Console**:
Any client of the wire protocol — the foldkit frontend (the primary surface, reached through the deployment's domain) and the CLI (scripting, headless). Consoles never hold session state; they attach, tail, and command.
_Avoid_: client, app

**Auto-title**:
A quick-started thread's name lifecycle: the prompt snippet at birth, upgraded to an LLM-generated title (`title — snippet`) by the worker after the thread's first settled run. Applies only to quick-started threads — names the user typed are never rewritten.
_Avoid_: rename, retitle

**Quick start**:
Starting a thread with its first prompt in one gesture: the thread is created (named from the prompt), opened, and set to work immediately.
_Avoid_: new-thread dialog, quick-fire

**Mode**:
A thread's hands policy, hard-pinned at creation: `local` (the user's own machine is the hands, through the **env daemon**); `sandbox` (a **Freestyle** VM); `any` (local preferred, sandbox fallback). The pin is deliberate — switching modes mid-thread changes which filesystem the hands see, which would corrupt a thread's identity.
_Avoid_: type, flavor, exec-target

**Env**:
The hands provider behind a thread's mode: the local machine (via the **env daemon**) or a sandbox VM (**Freestyle** — the provider of record, ADR 0008; the **Box** integration it replaces is incomplete). The worker never knows which; the thread's mode decides.
_Avoid_: executor, shell, runtime, sandbox (that's the mode name)

**Env daemon**:
The hands process: one binary, one protocol. Runs on the user's machine (local mode — reachable from anywhere through the hub's relay) or inside a Box (sandbox mode — exposed through the box's private URL). Executes the pi tool surface (`read`/`bash`/`edit`/`write`) against the thread's workspace.
_Avoid_: agent, worker, executor

**Relay**:
The hub's outbound bridge: the env daemon dials the hub (relay_hello, deployment secret) and a worker's `RemoteEnv` attaches (relay_attach); the hub pipes the two sockets — the env protocol flows through uninterpreted. The user's machine needs no open ports. Box envs skip the relay: the worker connects to the `host --private` URL directly.
_Avoid_: tunnel, vpn, proxy

**Box**:
The former remote sandbox provider (ascii.dev). One Box per thread, lazily provisioned by the hub on first use, stopped by **idle-stop** between uses. A Box is a disposable machine: snapshot on stop, resume in seconds. **Incomplete — superseded by Freestyle (ADR 0008)**: kept selectable for development/parity (`SAKU_ENV_PROVISIONER=box`), not the production path.
_Avoid_: sandbox (the mode name), orb (amp's word), VM

**Freestyle**:
The remote sandbox provider (freestyle.sh), chosen by ADR 0008 to replace Box. Full Linux VMs (root, Docker, nested KVM) with suspend/resume — only storage is billed while suspended. One VM per thread, lazily provisioned by the hub on first use (`SAKU_ENV_PROVISIONER=freestyle` + `FREESTYLE_API_KEY`), suspended by **idle-stop** between uses. The backend is in preparation: the deployment fails loudly until it lands.
_Avoid_: sandbox (the mode name), box (the ascii.dev provider)

**Idle-stop**:
The env lifecycle policy: a Box that has been idle is stopped (snapshot, billing paused) by the hub and resumed on the next prompt; local envs never stop. In the deployment, the thread DO owns the timer as a Durable Object alarm (armed via the hub's `/arm-idle`, cleared on activity): the alarm fires in the worker and pushes `idleStopFired` back to the hub, which validates, releases, and flips the env axis.
_Avoid_: timeout, auto-stop (Box's own wall-clock TTL — a different thing)

**Registry**:
Hub-owned index of threads (id → name, cwd, mode, env). Consoles list and attach through the hub. Future: a factory hub enumerating every machine's threads.
_Avoid_: db, table, catalog

**Pi sessions**:
The pi session files on the user's machine (`~/.pi/agent/sessions/` — v3, the format pi's shell writes today, and v4, pi-agent-core's jsonl format), listed and adopted through the local daemon. The console's rail lists them under the threads (only the unadopted ones — a session is a thread once opened) and a click opens one: adoption is what opening a session means, never an import gesture. Import is **adoption**: the file is read once through pi's own semantics and replayed into the thread's own trail; the pi file is never written, and the thread record's `source` provenance pins where it came from (re-import is idempotent). Only the local daemon serves these commands — the hub has no `~/.pi` (the mirror of skills being hub-only).
_Avoid_: migration, bridge, sync, export

**Project**:
A cwd the user has explicitly added to the session window (the t3code-style "add project" gesture — CONTEXT.md: Add project). The window is project-scoped: the daemon lists only the added projects' pi sessions (never a full scan of `~/.pi`), matching each project's own session dir (pi's per-cwd layout) plus every subdirectory's, with the file header's real `cwd` verifying membership (pi's dir encoding is lossy — a dash in a name is indistinguishable from a separator). Projects are daemon-local state (`projects.json`), served only by the local daemon — the hub answers `projects_not_served`. A project is a scoping list entry, never a thread grouping: threads carry their own cwd, and removing a project never touches adopted threads.
_Avoid_: workspace, repo, folder

**Add project**:
The explicit gesture that registers a cwd in the session window — the rail's `＋` input (a typed path) or `saku project add <path>`. Adding is idempotent (re-adding is a no-op); the project appears expanded with its sessions loading. Sessions themselves are lazy: a project's list loads on first expand and caches — connect never reads pi session files.
_Avoid_: import-project (adoption is the only import, and it imports sessions, not projects)

**Archive**:
A thread's visibility lifecycle, t3code-style: archiving moves the thread out of the active list into the rail's archived view (muted rows, unarchive + delete). Metadata-only — the trail, session, and env are untouched, and unarchive is always possible. An archived thread still runs, still broadcasts, and can still be renamed.
_Avoid_: settle (that's a run-lifecycle word: a run settles), delete, hide

**Wire**:
The protocol between consoles and the hub: pi's own session vocabulary (`pi-agent-core`'s `AgentEvent`/`Entry` types, partial snapshots stripped as pi's own shell does) extended with a thread layer (registry ops, session commands, `settled`/`entry_appended`). The standing rule: **extend pi, never shim it** — pi's public types go on the wire verbatim; saku only adds what pi lacks (threads). JSONL frames over WebSocket; the hub's domain is the address, a deployment secret the credential.
_Avoid_: api, rpc-as-a-name (pi calls its JSONL framing “RPC”; the wire is the full protocol)

**Skills / Prompt Templates**:
Pi's own extension vocabulary, saku-hosted (amp-style): the hub keeps a skills store with `personal` and `workspace` scopes; skills are imported from repos, updated, and loaded by every worker from the hub — a Box has no `~/.pi/agent/`, so the hub is the only place they can come from. The thread's repo `.pi/` still contributes in place. The extension system itself (extension UI, slash commands, extension-provided models) is shell-only and cut from v1 — if it ever lands, it enters through the same wire seam. Same philosophy as pi: never invent parallel concepts — stay minimal, stay extensible.
_Avoid_: plugins (pi says extensions), modules, addons

**Deployment**:
The deployable whole: one alchemy program (`packages/deploy/alchemy.run.ts`) declaring the Worker, the `HUB` and `THREAD` Durable Object namespaces, the deployment secret, and the Box/static-provisioner config — targeted at Cloudflare (`bun alchemy deploy`) or celld (the hand-maintained twin in `packages/deploy/celld/`). The DO classes (`SakuHubDO`, `SakuThreadDO`) are plain workerd — no alchemy runtime in the entry bundle — so the same code ships to both hosts. Model credentials are not deployment secrets: the catalog registers only the opencode-go provider (local: pi's `auth.json`/`models.json`; deployed: `OPENCODE_API_KEY` off the worker's bindings).
_Avoid_: app, service, api

**Env handle**:
What the hub hands the worker after provisioning: the env daemon's URL + token (+ relay identity for local envs). The worker rebuilds its `RemoteEnv` connection from the handle — pushed on provisioning and on resume, cleared on release.
_Avoid_: credentials, ticket, lease

**Static provisioner**:
The deployment's `SAKU_ENV_PROVISIONER=static` mode (dev/celld shape): one configured env daemon at `SAKU_ENV_URL` is every thread's env — no provisioning loop. The Box provisioner remains the selectable default but is **incomplete**; the intended production provider is Freestyle (ADR 0008).
_Avoid_: local mode (the mode name is a per-thread pin, this is a deployment shape)
