# saku — 作, the software factory

A control plane for pi coding agents: a daemonized **worker** hosts agent **threads**
on your machine; **consoles** (TUI, CLI, future GUI) connect to it over one **wire**
protocol. Pi-only by design — the wire is a projection of pi's own session model.

See [`CONTEXT.md`](./CONTEXT.md) for the vocabulary and `docs/adr/` for the
architecture decisions (highlights: the wire reuses pi's RPC protocol;
local-first, with the cloud/durable-object brain deferred behind seams; no
approval gates; pi-only).

## Layout

| package            | role                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `packages/foldtui` | library: render foldkit apps in the terminal via OpenTUI (publishable, no saku concepts) |
| `packages/wire`    | protocol: pi's RPC vocabulary + thread layer (registry ops, attach/tail)                 |
| `packages/worker`  | the execution pod: thread sessions per thread, daemon, sandbox/hands seam                |
| `packages/cli`     | the `saku` binary: worker steward + headless console (`daemon`, `run`, …)                |
| `packages/tui`     | the console: foldtui app (thread list, thread view, extension dialogs)                   |
| `packages/demo`    | foldtui demo + smoke tests                                                               |

## Current state (scaffold)

- Monorepo tooling: pnpm workspace, turbo (build/typecheck/test), vite-plus
  (fmt/lint/staged), tsdown per package, vitest.
- `@saku/wire` seeds the protocol: pi's RPC types re-exported + thread commands.
- `@saku/worker/@saku/cli/@saku/tui` are empty shells awaiting implementation.

## Development

```bash
pnpm install
pnpm typecheck   # turbo: all packages
pnpm test        # turbo: vitest per package
pnpm build       # turbo: tsdown per package
pnpm demo        # run the foldtui counter demo
pnpm smoke       # headless e2e test of the foldtui binding
pnpm fmt / pnpm lint / pnpm check   # vite-plus
```

Tooling conventions follow pi where it matters: skills, extensions, prompt
templates, sessions, settings — pi's own vocabulary and extension surface ride
through the worker unmodified.
