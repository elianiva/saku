# 0006 — The console opens on a home prompt, not the registry

Status: accepted

## Context

The TUI's default screen was the thread list. Grilling exposed the goal:
the console should feel like pi with no session started — a prompt box is
the entry point, not a registry browser. Resolved together with it: how
threads get named when born from a prompt, and how a user moves around a
session's message tree once it forks.

## Decision

The console is a three-screen TEA app: **home** (default, pi's empty
session shape: header, blank canvas, prompt box), **list** (the registry,
one key away), **thread** (flat transcript + input, now with a back-stack
and a tree overlay). Details:

- **Quick start.** Submitting the home prompt creates a thread named from
  the prompt snippet (first line, collapsed whitespace, ~60 chars,
  `untitled` fallback), opens it, and sends the prompt — one gesture.
  `create_thread` carries a new `autoName` flag so the worker knows the
  name is a snippet, not a user choice.
- **Auto-title.** After a quick-started thread's first settled run, the
  worker generates a title with a pinned lightweight model
  (`opencode-go`/`deepseek-v4-flash` via pi-ai `complete`, same prompt as
  the shell's auto-session-title extension) and renames the registry
  record to `title — snippet`, broadcasting `thread_changed`. The flag is
  cleared by a successful title or by a user rename (`/name`), so a
  failed attempt retries on the next settled run and user names are never
  rewritten.
- **Slash commands.** Pi's `/`-command vocabulary, scoped to what the
  wire supports: `/tree /model /thinking /compact /name /resume /new
  /quit /help` (v1). A registry in the TUI (one entry per command) is the
  extension point; commands emit messages, they never mutate the model.
  Unknown commands surface an error, exactly like pi.
- **Session navigation.** A `branch` session command moves the session's
  leaf to a past entry (`session.moveLane("main", entryId)` — pi-agent-core's
  own vocabulary, bare branch, no summary) and returns the new `leafId`.
  It is guarded to idle threads only. The tree overlay (double-esc or
  `/tree`) renders the whole session tree client-side from `parentId` +
  `leafId` — pi's `├ └ │` connectors and active-path marker, no wire call
  to open, no folds/search/filters until forks exist.
- **`/name` renames the registry, not the pi session.** The visible
  thread name is registry-owned; `set_session_name` keeps meaning the pi
  session name. `rename_thread` is a thread-layer command, per the
  extend-pi-never-shim rule.
- **Dead `Created` handler removed.** Creation flows (`quick start`, the
  `n` dialog) chain create → open → (prompt) effects; the list refreshes
  from `thread_changed` broadcasts.

## Consequences

- The default console surface is a prompt box; the registry is a tool,
  not the home.
- Thread names are worker-managed for quick-started threads — a
  background model call per new thread (cheap model, silent failure, no
  queue).
- Branching becomes possible: sessions can fork from past messages, and
  the flat transcript shows the whole trail while the overlay shows the
  structure. Fork-aware context (branch summaries, folds) is deferred
  until the worker grows real fork UX.
- The wire gains two thread-layer/session commands (`rename_thread`,
  `branch`) — both in existing vocabulary seams, no protocol rework.
