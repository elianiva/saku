# Saku

A software factory for pi coding agents. A daemonized **worker** hosts agent **threads** on your machine; **consoles** (TUI, CLI, future GUI) connect to it over one **wire** protocol. Pi-only by design — no generic agent layer; the wire is a projection of pi's own session model, so integration is deep rather than abstract. The long-term shape — threads as durable objects in the cloud, sandboxed remote hands — is designed for but intentionally not built yet (see `docs/adr/0002`).

## Language

**Saku**:
The project itself. A software factory: threads go in, results come out. This monorepo is the project (`packages/foldtui`, `wire`, `worker`, `cli`, `tui`).
_Avoid_: the-factory, control-plane

**Thread**:
The durable unit of agent work: a pi session plus registry metadata (name, cwd, `mode`). Owns one session tree — the append-only log of messages, tool calls, and compactions. Future: one Durable Object per thread.
_Avoid_: session (pi's word for the log machinery), task, job, run, conversation

**Worker**:
The execution pod. A long-lived daemon process per machine that owns the thread registry, hosts one pi session runtime per thread (pi's `AgentSessionRuntime`/`SessionManager` directly, no wrapper), and serves the wire protocol on a unix socket. The seam where remote execution rendezvous later (the same worker, different transport and hands).
_Avoid_: daemon (that's a lifecycle detail), server, backend, host

**Session**:
The pi agent session inside a thread — the machinery that owns a message tree (entries, lanes, compaction, forks) and speaks pi's RPC event vocabulary. A thread wraps exactly one session.
_Avoid_: conversation, chat, log

**Console**:
Any client of the wire protocol — the TUI (interactive), the CLI (headless, scripting), the future GUI. Consoles never hold session state; they attach, tail, and command.
_Avoid_: client, frontend, app

**Mode**:
A thread's hands policy, hard-pinned at creation: `local` (the worker's own machine is the hands); later `remote` (a sandbox provider); later `any` (local preferred, sandbox fallback). The pin is deliberate — switching modes mid-thread changes which filesystem the hands see, which would corrupt a thread's identity.
_Avoid_: type, flavor, exec-target

**Registry**:
Worker-owned index of threads (id → name, cwd, mode). Consoles list and attach from it. Future: a factory hub enumerating every machine's threads.
_Avoid_: db, table, catalog

**Wire**:
The protocol between consoles and the worker: pi's RPC vocabulary (commands, responses, events, extension UI) extended with a thread layer (registry ops, attach/tail). JSONL frames, unix socket transport, auth token. See `docs/adr/0001`.
_Avoid_: api, rpc-as-a-name (pi calls its JSONL framing “RPC”; the wire is the full protocol)

**Hands**:
Where pi execution physically happens. `local` = the worker's own filesystem (current system). Future: a sandbox provider (Cloudflare Sandbox, or container) behind `mode: remote`. The worker never knows which; the thread's mode decides.
_Avoid_: executor, shell, runtime

**Skills / Extensions / Prompt Templates / Themes**:
Pi's own extension vocabulary, carried through unchanged via the worker (`.pi/`, `~/.pi/agent/`). Consoles render the extension-UI requests (dialogs, editor, notifications). Same philosophy as pi: never invent parallel concepts — stay minimal, stay extensible.
_Avoid_: plugins (pi says extensions), modules, addons
