/**
 * Thread presentation (presentation.ts): the one derivation of how a thread
 * is shown. The state/env icon classification (icon, tone, title), the mode
 * icon, the header's state/env presentation, and the rail's pi-session filter
 * all live here — the rail and pane views render from these, so adding a state
 * or env value touches exactly one file. The derivation is shared.
 */

import type {
  PiSessionInfo,
  ThreadEnvState,
  ThreadInfo,
  ThreadMode,
  ThreadState,
  WireModelInfo,
} from "@saku/wire";

import type { IconName } from "./icon.ts";
import type { EntryProjection } from "./thread/projection.ts";

const modeIcons = {
  local: "laptop",
  sandbox: "box",
  any: "shuffle",
} satisfies Record<ThreadMode, IconName>;

/** The rail's mode icon: the hands-policy mode (CONTEXT.md: Mode). */
export const modeIcon = (mode: ThreadMode) => modeIcons[mode];

/** How the rail draws a thread state: icon, tone, title. */
export interface StatePresentation {
  readonly icon: IconName;
  readonly tone: string;
  readonly title: string;
}

const statePresentations = {
  idle: { icon: "circle", tone: "text-muted", title: "idle" },
  working: { icon: "loaderCircle", tone: "text-gold animate-spin", title: "working" },
  interrupted: {
    icon: "circleAlert",
    tone: "text-rose",
    title: "interrupted — recovery on next command",
  },
} satisfies Record<ThreadState, StatePresentation>;

export const statePresentation = (state: ThreadState) => statePresentations[state];

/** How the rail draws a thread's env: icon, tone, title. */
export interface EnvPresentation {
  readonly icon: IconName;
  readonly tone: string;
  readonly title: string;
}

const envPresentations = {
  ready: { icon: "circleCheck", tone: "text-foam", title: "env ready" },
  provisioning: {
    icon: "loaderCircle",
    tone: "text-gold animate-spin",
    title: "env provisioning",
  },
  stopped: { icon: "circleStop", tone: "text-muted", title: "env stopped — resumes on prompt" },
  error: { icon: "circleX", tone: "text-love", title: "env error — next prompt retries" },
} satisfies Record<ThreadEnvState, EnvPresentation>;

export const envPresentation = (env: ThreadEnvState) => envPresentations[env];

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
export const contextUsage = (entries: readonly EntryProjection[], model: WireModelInfo | null) => {
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

/** The t3code-style preview: only a few rows at a time (CONTEXT.md: Archive
 *  sidebar mechanics); "show more" expands. */
export const PREVIEW_LIMIT = 6;

/** Slice to the preview when collapsed; everything when expanded. */
export const previewSlice = <T>(items: readonly T[], showMore: boolean) =>
  showMore || items.length <= PREVIEW_LIMIT ? items : items.slice(0, PREVIEW_LIMIT);

/** The active threads: the list minus the archived (CONTEXT.md: Archive). */
export const activeThreads = (threads: readonly ThreadInfo[]) =>
  threads.filter((thread) => thread.archivedAt === null);

/** The archived threads: settled out of the active list. */
export const archivedThreads = (threads: readonly ThreadInfo[]) =>
  threads.filter((thread) => thread.archivedAt !== null);

/** A project's display name: the path's basename. */
export const projectName = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

/** A compact relative time ("just now", "5m", "3h", "2d", then a date). */
export const relativeTime = (ms: number) => {
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
};

/** The header's state/env presentation: values and tone. */
export const headerState = (state: ThreadState | undefined, env: ThreadEnvState | undefined) => ({
  state,
  env,
  tone: state === "working" ? "text-gold" : env === "error" ? "text-love" : "text-subtle",
});
