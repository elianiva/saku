# foldtui

Render [foldkit](https://foldkit.dev) (Elm-architected, Effect-based) applications in the
terminal via [OpenTUI](https://opentui.com). The demo is a clickable counter whose
`main.ts` is identical in shape to a foldkit web app: `Schema` model, `m()` messages,
one pure `update`, one pure `view`.

```
┌───────────────────────────────────────────────────────────────┐
│   Foldkit × OpenTUI — TEA counter                             │
│                                                               │
│   Count: 0                                                    │
│                                                               │
│        ┌─────┐   ┌─────────┐   ┌─────┐                        │
│        │  -  │   │  Reset  │   │  +  │                        │
│        └─────┘   └─────────┘   └─────┘                        │
└───────────────────────────────────────────────────────────────┘
```

## How it works

- **`packages/foldtui`** — the binding. Implements a minimal TEA loop (message queue →
  `update` → `view` → patch) on top of foldkit's public API, then diffs the view's
  vnode tree against the previous render and maintains a parallel OpenTUI renderable
  tree (`packages/foldtui/src/patcher.ts`). `h.OnClick(msg)` handlers land in
  `vnode.data.on.click`; OpenTUI has no DOM-style click, so the binding synthesizes
  one from `mousedown`+`mouseup` on the same renderable (`src/events.ts`).
- **`packages/demo`** — the counter. `src/main.ts` is pure TEA (renderer-agnostic);
  `src/entry.ts` boots it in the terminal. `scripts/smoke.ts` is an end-to-end test
  that runs the demo on in-memory streams and drives it with real SGR mouse-click
  sequences.
- **`patches/foldkit@0.140.1.patch`** — a pnpm patch. Foldkit's public API does not
  yet export the three internals a terminal renderer needs, so the patch re-exports
  them through the public barrels (no behavior change):
  - `foldkit/html`: `htmlBuilder` (the `HtmlBuilder` factory), `setHtmlRuntime` /
    `clearHtmlRuntime` (push/pop the dispatch frame around `view`)
  - `foldkit/runtime`: `Dispatch` (the message-dispatch context service)

## Setup

Requires pnpm (v10+; developed against 11.3) and bun (for running TS directly).

```bash
pnpm install     # applies patches/foldkit@0.140.1.patch automatically
```

## Run

```bash
pnpm demo        # run the counter in your terminal (mouse: click the buttons)
pnpm smoke       # headless end-to-end test: renders + injects real clicks, asserts 0→1→2→1→0
pnpm typecheck
```

## Re-generating the patch

The patch edits the compiled `dist/` of the published package:

```bash
pnpm patch foldkit@0.140.1
# edit the extracted dir: add the re-exports to dist/html/public.{js,d.ts} and
# dist/runtime/public.{js,d.ts}
pnpm patch-commit <dir>
```

If foldkit later exports these officially, delete `patches/`, drop
`patchedDependencies` from `pnpm-workspace.yaml`, and remove the entries from the
lockfile (`pnpm install` does this when the section is gone).

## Mapping (MVP)

| foldkit                                                      | foldtui                                          |
| ------------------------------------------------------------ | ------------------------------------------------ |
| `div`, `section`, `button`, ...                              | `BoxRenderable` (Yoga flexbox, default column)   |
| `p`, `span`, `h1`–`h6`, `strong`, `em`, `label`, `code`, ... | `TextRenderable` (when all children are text)    |
| `Style` layout props (sizes, flex, gap, padding, margin)     | OpenTUI setters (string values coerced)          |
| `Style` colors (`color`, `backgroundColor`)                  | text `fg`/`bg`; box `backgroundColor`            |
| `OnClick`                                                    | synthesized click from mousedown+mouseup         |
| `OnMouseDown/Up/Move/Over/Out`                               | OpenTUI mouse handlers                           |
| `Command`                                                    | forked as Effect, result message dispatched back |
| `document.title`, `head` metadata                            | ignored                                          |

Known limitations (MVP): children diff positionally (no keyed moves — key mismatch
replaces); keyboard events (`OnKeyDown`) not wired; `input`/`textarea`/`img`/`canvas`
render as boxes with a warning; CSS classes are ignored; mouseenter/mouseleave
unmapped (use mouseover/mouseout).
