/**
 * Thread presentation (presentation.ts): the one derivation of how a thread
 * is shown. The state/env glyph classification (char, tone, title), the mode
 * glyph char, the header's `state · env` line, and the rail's pi-session
 * filter all live here — the rail and pane views render from these, so
 * adding a state or env value touches exactly one file. Rendered output is
 * unchanged; only the derivation is shared.
 */

import type { PiSessionInfo, ThreadEnvState, ThreadInfo, ThreadMode, ThreadState, WireModelInfo } from "@saku/wire";

import type { EntryProjection } from "./thread/projection.ts";


/** The rail's mode glyph: the hands-policy initial (CONTEXT.md: Mode). */
export const modeChar = (mode: ThreadMode) =>
  mode === "sandbox" ? "S" : mode === "any" ? "A" : "L";

/** How the rail draws a thread state: glyph char, tone, title. */
export interface StatePresentation {
  readonly glyph: string;
  readonly tone: string;
  readonly title: string;
}

export const statePresentation = (state: ThreadState) =>
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

export const envPresentation = (env: ThreadEnvState) =>
  env === "ready"
    ? { glyph: "▸", tone: "text-foam", title: "env ready" }
    : env === "provisioning"
      ? { glyph: "◇", tone: "text-gold animate-pulse", title: "env provisioning" }
      : env === "stopped"
        ? { glyph: "▽", tone: "text-muted", title: "env stopped — resumes on prompt" }
        : { glyph: "✕", tone: "text-love", title: "env error — next prompt retries" };

/** The composer's model badge: the id when it already carries the provider
 *  prefix, else `provider/id` (humanlayer's strip-the-prefix rule). */
export const modelLabel = (model: { readonly provider: string; readonly id: string }) =>
  model.id.includes("/") ? model.id : `${model.provider}/${model.id}`;

/** The context badge's thresholds, humanlayer's 60/90 rule. */
export const CONTEXT_WARNING_PERCENT = 60;
export const CONTEXT_CRITICAL_PERCENT = 90;

/** Tone for a context-usage percent: foam below the warning, gold below the
 *  critical threshold, love past it. */
export const contextTone = (percent: number) =>
  percent >= CONTEXT_CRITICAL_PERCENT
    ? "text-love"
    : percent >= CONTEXT_WARNING_PERCENT
      ? "text-gold"
      : "text-foam";

/** pi's per-request context size from a usage payload: the native
 *  `totalTokens`, else the component sum (pi's own shell rule, decoded in
 *  the console — ADR 0005). Null when the payload carries neither. */
export const usageContextTokens = (usage: unknown) => {
  if (typeof usage !== "object" || usage === null) return null;
  const record = usage as Record<string, unknown>;
  if (typeof record.totalTokens === "number") return record.totalTokens;
  const input = typeof record.input === "number" ? record.input : 0;
  const cacheRead = typeof record.cacheRead === "number" ? record.cacheRead : 0;
  const cacheWrite = typeof record.cacheWrite === "number" ? record.cacheWrite : 0;
  const tokens = input + cacheRead + cacheWrite;
  return tokens > 0 ? tokens : null;
};

/** The composer's context badge: the trail's last assistant usage against
 *  the model's window, or null when unknown (no model window, no usage yet,
 *  or a compaction since the last usage — pi's own shell rule: context is
 *  unknown until the next assistant response). A pure read of the trail;
 *  the console never computes thread state elsewhere (ADR 0004). */
export const contextUsage = (
  entries: readonly EntryProjection[],
  model: WireModelInfo | null,
) => {
  const window = model?.contextWindow ?? 0;
  if (window <= 0) return null;
  let tokens: number | null = null;
  let usageSeq = -1;
  let compactionSeq = -1;
  for (const entry of entries) {
    const seq = entry.seq ?? -1;
    if (entry.type === "compaction") compactionSeq = seq;
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message === undefined || message.role !== "assistant") continue;
    if (message.stopReason === "aborted" || message.stopReason === "error") continue;
    const next = usageContextTokens(message.usage);
    if (next === null) continue;
    tokens = next;
    usageSeq = seq;
  }
  if (tokens === null || compactionSeq > usageSeq) return null;
  return {
    tokens,
    window,
    percent: Math.round((tokens / window) * 100),
  };
};

/** The pi sessions the rail lists: those not yet adopted as threads. A
 *  session is adopted when some thread's provenance pins its path
 *  (CONTEXT.md: Pi sessions — adoption, not a bridge); the thread record's
 *  `source` is the key, so a thread created from scratch never matches. */
export const unadoptedPiSessions = (
  threads: readonly ThreadInfo[],
  sessions: readonly PiSessionInfo[],
) => {
  const adopted = new Set<string>();
  for (const thread of threads) {
    const source = thread.source;
    if (source !== undefined && source.kind === "pi") adopted.add(source.path);
  }
  return sessions.filter((session) => !adopted.has(session.path));
};

/** The header's `state · env` line: text and tone. */
export const headerState = (
  state: ThreadState | undefined,
  env: ThreadEnvState | undefined,
) => {
  const pieces: string[] = [];
  if (state !== undefined) pieces.push(state);
  if (env !== undefined) pieces.push(`env ${env}`);
  return {
    text: pieces.join(" · "),
    tone: state === "working" ? "text-gold" : env === "error" ? "text-love" : "text-subtle",
  };
};
