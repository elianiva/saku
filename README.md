# saku — 作, the software factory

A control plane for pi coding agents: a daemonized **worker** hosts agent **threads**
on your machine; **consoles** (TUI, CLI, future GUI) connect to it over one **wire**
protocol. Pi-only by design — the wire is a projection of pi's own session model.

See [`CONTEXT.md`](./CONTEXT.md) for the vocabulary, `docs/plans/0001-local-spine.md`
for the implemented spine, and `docs/adr/` for the architecture decisions
(highlights: the wire carries pi's vocabulary verbatim and extends it with a
thread layer; the worker is a supervisor with in-process sessions; local-first,
with the cloud/durable-object brain deferred behind seams; no approval gates;
pi-only).

## Layout

| package            | role                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `packages/foldtui` | library: render foldkit apps in the terminal via OpenTUI (publishable, no saku concepts) |
| `packages/wire`    | the wire protocol: framing, handshake, thread + session commands, typed `WorkerClient`    |
| `packages/worker`  | the daemon: `SessionHost` per thread on pi-agent-core, registry, model catalog, socket     |
| `packages/cli`     | the `saku` binary: daemon steward (`daemon start/stop/status`) + `list`/`new`/`open`/`rm` |
| `packages/tui`     | the console: foldtui app (thread list, thread view, dialogs, reconnect catch-up)          |
| `packages/demo`    | foldtui counter demo + smoke test for the foldtui binding                                 |

## Current state

The local spine is built and verified end to end: the worker smoke drives a
hermetic daemon (handshake, registry ops, threads that start only on the first
message, durable entries, error paths, clean shutdown); the CLI auto-starts the
daemon on demand and reuses a running one; the TUI renders, takes keys, and
dialogues in a pty. `saku run` (headless console) is deferred — the CLI is the
daemon steward.

## Prerequisites

- **Node ≥ 26** — source runs directly via type stripping, no build step
  (shipped code must therefore avoid `!` non-null assertions and constructor
  parameter properties, which strip mode rejects).
- **pnpm 11** — `packageManager` is pinned in `package.json`.
- **Python 3** (stdlib only) — for `scripts/pty-drive.py`, the TUI test harness.
- **`--experimental-ffi`** — OpenTUI's native FFI backend needs this Node flag;
  `saku open` passes it automatically, direct TUI runs need it by hand
  (see below).

## Setup

```bash
pnpm install
```

There is no build step for development: everything runs from source. `pnpm build`
(tsdown) exists for packaging and is exercised by CI-style checks.

## Running the stack

The CLI lives behind the root `saku` script — `pnpm saku <command>` runs
`node packages/cli/src/entry.ts <command>` (no `saku` bin is linked into the
workspace).

Every command that talks to the worker **auto-starts the daemon** when it is
not running (probe first, spawn only if nothing answers — opencode-style) and
**reuses a running daemon** otherwise.

```bash
# daemon lifecycle
pnpm saku daemon start
pnpm saku daemon status
pnpm saku daemon stop

# threads
pnpm saku new <name> [--cwd <dir>] [--mode local|sandbox|any]
pnpm saku list
pnpm saku rm <thread>

# the TUI (spawns with --experimental-ffi); no args opens the TUI too
pnpm saku
pnpm saku open [thread]

# or the TUI directly, without the CLI:
node --experimental-ffi packages/tui/src/entry.ts
```

Opening a thread in the TUI **connects without starting anything**: the thread's
pi session is created only when the first message is sent (read-only commands
are served from the registry). A fresh thread defaults to the first available
model from `~/.pi/agent/auth.json`.

Everything is redirected by `SAKU_HOME` (default `~/.saku`):
`worker.sock`, `auth` (the connection token, 0600), `worker.log`,
`threads/<id>/thread.json` + `threads/<id>/sessions/`. `PI_CODING_AGENT_DIR`
(default `~/.pi/agent`) redirects `auth.json` / `models.json` — set both to a
temp dir for hermetic runs.

## Testing

```bash
pnpm typecheck   # turbo: tsc --noEmit in every package
pnpm test        # turbo: vitest per package (passWithNoTests)
pnpm build       # turbo: tsdown per package
```

Two end-to-end smokes cover the spine without any manual setup:

| Script             | What it proves                                                                          |
| ------------------ | --------------------------------------------------------------------------------------- |
| `pnpm smoke`       | the foldtui binding: real demo app on in-memory streams, scripted SGR mouse clicks      |
| `pnpm smoke:worker`| the whole spine: hermetic daemon (`SAKU_HOME` + `PI_CODING_AGENT_DIR` in a temp dir), bad-token rejection, registry ops, read-only commands never starting a session, first message starting it, durable entries, refused-without-daemon, clean SIGTERM shutdown |

```bash
pnpm smoke          # demo: initial render, click + twice, click -, click Reset
pnpm smoke:worker   # asserts PASS/FAIL per step; ends with "SMOKE OK"
```

### Driving the TUI in a pty

The TUI needs a real terminal, so its test harness is a small Python pty driver
(`scripts/pty-drive.py`, stdlib only): it spawns the app on a pseudo-terminal,
waits for a marker substring in the output, then sends scripted keys with
delays (OpenTUI needs keys as short single-character bursts after its ~2-3s
init).

```bash
# boot the TUI with no daemon running: expect the "cannot reach the worker"
# dialog, then quit (exit code 0 = clean quit)
python3 scripts/pty-drive.py --wait "saku" --keys "q:1.0" --timeout 20 -- \
  node --experimental-ffi packages/tui/src/entry.ts

# with a daemon running and a thread created (auto-start first):
pnpm saku daemon start
pnpm saku new demo
python3 scripts/pty-drive.py --wait "demo" --keys "j:0.4,\r:0.8,\x1b:0.5,q:1.0" --timeout 25 -- \
  node --experimental-ffi packages/tui/src/entry.ts
#   j        move cursor to the thread
#   \r       open it (thread view renders; no session starts)
#   \x1b     back to the list
#   q        quit
```

The raw output is the assertion surface: grep it for dialog text, or parse
cursor sequences (`\x1b[ROW;COLH` + cell) for rendered values — OpenTUI diffs
its output, so a full-line grep only works for text that appears verbatim
(dialog messages, status bar labels).

```bash
pnpm demo   # the foldkit counter demo in your terminal (needs a TTY)
```

## Conventions

Tooling conventions follow pi where it matters: skills, extensions, prompt
templates, sessions, settings — pi's own vocabulary and extension surface ride
through the worker unmodified. In the wire, pi's public types cross verbatim;
saku adds only what pi lacks (threads) — extend pi, never shim it.
