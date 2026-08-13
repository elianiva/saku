/**
 * Thread presentation (presentation.ts): the one derivation of how a thread
 * is shown. The active-thread lookup against the rail, the state/env glyph
 * classification (char, tone, title), the mode glyph char, and the header's
 * `state · env` line all live here — rail.ts and thread-pane.ts render from
 * these, so adding a state or env value touches exactly one file. Rendered
 * output is unchanged; only the derivation is shared.
 */

import type { ThreadEnvState, ThreadInfo, ThreadMode, ThreadState } from "@saku/wire";

import type { Model } from "./model.ts";

/** The selected thread against the rail (the one active lookup). */
export const activeThread = (model: Model): ThreadInfo | undefined =>
  model.rail._tag === "ready"
    ? model.rail.threads.find((candidate) => candidate.id === model.active)
    : undefined;

/** The rail's mode glyph: the hands-policy initial (CONTEXT.md: Mode). */
export const modeChar = (mode: ThreadMode): "L" | "S" | "A" =>
  mode === "sandbox" ? "S" : mode === "any" ? "A" : "L";

// -- glyphs -----------------------------------------------------------------

/** How the rail draws a thread state: glyph char, tone, title. */
export interface StatePresentation {
  readonly glyph: string;
  readonly tone: string;
  readonly title: string;
}

export const statePresentation = (state: ThreadState): StatePresentation =>
  state === "idle"
    ? { glyph: "○", tone: "text-muted", title: "idle" }
    : state === "working"
      ? { glyph: "●", tone: "text-gold animate-pulse", title: "working" }
      : { glyph: "◐", tone: "text-rose", title: "interrupted — recovery on next command" };

/** How the rail draws a thread's env: glyph char, tone, title. */
export interface EnvPresentation {
  readonly glyph: string;
  readonly tone: string;
  readonly title: string;
}

export const envPresentation = (env: ThreadEnvState): EnvPresentation =>
  env === "ready"
    ? { glyph: "▸", tone: "text-foam", title: "env ready" }
    : env === "provisioning"
      ? { glyph: "◇", tone: "text-gold animate-pulse", title: "env provisioning" }
      : env === "stopped"
        ? { glyph: "▽", tone: "text-muted", title: "env stopped — resumes on prompt" }
        : { glyph: "✕", tone: "text-love", title: "env error — next prompt retries" };

// -- the header -------------------------------------------------------------

/** The header's `state · env` line: text and tone. */
export const headerState = (
  state: ThreadState | undefined,
  env: ThreadEnvState | undefined,
): { readonly text: string; readonly tone: string } => {
  const pieces: string[] = [];
  if (state !== undefined) pieces.push(state);
  if (env !== undefined) pieces.push(`env ${env}`);
  return {
    text: pieces.join(" · "),
    tone: state === "working" ? "text-gold" : env === "error" ? "text-love" : "text-subtle",
  };
};
