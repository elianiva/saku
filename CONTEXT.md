# Saku

A software factory for pi coding agents. A daemonized **worker** hosts agent **threads** on your machine; **consoles** (TUI, CLI, future GUI) connect to it over one **wire** protocol. Pi-only by design — no generic agent layer; the wire is a projection of pi's own session model, so integration is deep rather than abstract. The long-term shape — threads as durable objects in the cloud, sandboxed remote hands — is designed for but intentionally not built yet (see `docs/adr/0002`).

## Language

**Saku**:
The project itself. A software factory: threads go in, results come out. This monorepo is the project (`packages/foldtui`, `wire`, `worker`, `cli`, `tui`).
_Avoid_: the-factory, control-plane

**Thread**:
The durable unit of agent work: a pi session plus registry metadata (name, cwd, `mode`). Owns one session tree — the append-only log of messages, tool calls, and compactions. Future: one Durable Object per thread.

Thread state is a channel every console can read without owning it: `idle` (no run in flight), `working` (a run or compaction is live), `crashed` (the in-process host threw; the next command rebuilds it from the entry trail), `interrupted` (a run was left open and was recovered as interrupted at first touch — derived from the trail, never a boot scan). Transitions broadcast as `thread_changed` events.
_Avoid_: session (pi's word for the log machinery), task, job, run, conversation

**Auto-title**:
A quick-started thread's name lifecycle: the prompt snippet at birth, upgraded to an LLM-generated title (`title — snippet`) by the worker after the thread's first settled run. Applies only to quick-started threads — names the user typed are never rewritten.
_Avoid_: rename, retitle

**Chat**:
A console's primary surface, one per console: header, message canvas, editor, footer. Either empty (no thread attached — the **Home**) or showing a live **thread**; the two states are the same shape, so quick start morphs in place — no screen switch. Never holds session state — it renders what the wire sends.
_Avoid_: session view, thread view (one surface, two states), chat log

**Home**:
The chat surface's no-thread state — pi's fresh-session shape: header, blank canvas, editor, footer. The default screen; the registry is one key away, never the default. Quick start happens in place: typing + enter attaches a thread and starts it.
_Avoid_: dashboard, launcher, start screen

**Quick start**:
Starting a thread with its first prompt in one gesture from the home prompt box: the thread is created (named from the prompt), opened, and set to work immediately.
_Avoid_: new-thread dialog, quick-fire

**Worker**:
The execution pod. A long-lived daemon process per machine that owns the thread registry and hosts one session runtime per thread — pi-agent-core's `Agent` + `Session` embedded directly, no wrapper, one process for all threads — and serves the wire protocol on a unix socket. The seam where remote execution rendezvous later (the same worker, different transport and hands).
_Avoid_: daemon (that's a lifecycle detail), server, backend, host

**Session**:
The pi agent session inside a thread — the machinery that owns a message tree (entries, lanes, compaction, forks) and speaks pi-agent-core's event vocabulary (`AgentEvent`, stripped of partial snapshots). A thread wraps exactly one session.
_Avoid_: conversation, log (chat is the console surface, not the machinery)

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
The protocol between consoles and the worker: pi's own session vocabulary (`pi-agent-core`'s `AgentEvent`/`Entry` types, partial snapshots stripped as pi's own shell does) extended with a thread layer (registry ops, session commands, `settled`/`entry_appended`). The standing rule: **extend pi, never shim it** — pi's public types go on the wire verbatim; saku only adds what pi lacks (threads). JSONL frames, unix socket transport, auth token.
_Avoid_: api, rpc-as-a-name (pi calls its JSONL framing “RPC”; the wire is the full protocol)

**Hands**:
Where pi execution physically happens. `local` = the worker's own filesystem (current system). Future: a sandbox provider (Cloudflare Sandbox, or container) behind `mode: remote`. The worker never knows which; the thread's mode decides.
_Avoid_: executor, shell, runtime

**Skills / Prompt Templates**:
Pi's own extension vocabulary that survives into saku: the worker loads skills and prompt templates from the thread's `.pi/` and `~/.pi/agent/` into the harness (pi-agent-core's `loadSkills`/`loadPromptTemplates`). The extension system itself (extension UI, slash commands, extension-provided models) is shell-only and cut from v1 — if it ever lands, it enters through the same wire seam. Same philosophy as pi: never invent parallel concepts — stay minimal, stay extensible.
_Avoid_: plugins (pi says extensions), modules, addons
