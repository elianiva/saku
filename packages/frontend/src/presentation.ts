/**
 * Thread presentation (presentation.ts): the one derivation of how a thread
 * is shown. The state/env icon classification (icon, tone, title), the mode
 * icon, the header's state/env presentation, and the rail's pi-session filter
 * all live here — the rail and pane views render from these, so adding a state
 * or env value touches exactly one file. The derivation is shared.
 */

import type {
  PiSessionInfo,
  ProjectDirEntry,
  ThreadEnvState,
  ThreadInfo,
  ThreadMode,
  ThreadState,
  WireModelInfo,
} from "@saku/wire";

import type { IconName } from "./icon.ts";
import { asString } from "./thread/format.ts";
import type { EntryProjection } from "./thread/projection.ts";

const modeIcons = {
  local: "laptop",
  sandbox: "box",
  any: "shuffle",
} satisfies Record<ThreadMode, IconName>;

/** The rail's mode icon: the hands-policy mode (CONTEXT.md: Mode). */
export const modeIcon = (mode: ThreadMode) => modeIcons[mode];

/** One row of the add-project picker's tree level: the up row (when the
 *  level has a parent) or one subdirectory. */
export type PickerRow =
  | { readonly kind: "up" }
  | { readonly kind: "dir"; readonly entry: ProjectDirEntry };

/** The picker's visible rows: the up row (when the level has a parent),
 *  then the level's subdirectories narrowed by the filter (basename
 *  substring). The highlight index walks this list; a level that has not
 *  landed (no Success) has no rows. */
export const pickerRows = (picker: {
  readonly parent: string | null;
  readonly entries:
    | { readonly _tag: "Success"; readonly data: readonly ProjectDirEntry[] }
    | { readonly _tag: "Idle" | "Loading" | "Refreshing" | "Stale" | "Failure" };
  readonly filter: string;
}): PickerRow[] => {
  if (picker.entries._tag !== "Success") return [];
  const needle = picker.filter.trim().toLowerCase();
  const rows: PickerRow[] = [];
  if (picker.parent !== null) rows.push({ kind: "up" });
  for (const entry of picker.entries.data) {
    if (needle.length > 0 && !entry.name.toLowerCase().includes(needle)) continue;
    rows.push({ kind: "dir", entry });
  }
  return rows;
};

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

/** The picker's filter: a case-insensitive match of the query against a
 *  model's label, provider, and id (the label alone misses the provider
 *  when the id already carries a prefix). Catalog order is preserved, and
 *  an empty query returns everything. */
export const filterModels = (models: readonly WireModelInfo[], query: string) => {
  const q = query.trim().toLowerCase();
  if (q === "") return models;
  return models.filter(
    (model) =>
      modelLabel(model).toLowerCase().includes(q) ||
      model.provider.toLowerCase().includes(q) ||
      model.id.toLowerCase().includes(q),
  );
};

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

/** A pi usage payload's token breakdown (input/output/cacheRead/cacheWrite),
 *  decoded defensively; null when the payload carries no components at all. */
export const usageBreakdown = (usage: unknown) => {
  if (typeof usage !== "object" || usage === null) return null;
  const record = usage as Record<string, unknown>;
  const input = typeof record.input === "number" ? record.input : 0;
  const output = typeof record.output === "number" ? record.output : 0;
  const cacheRead = typeof record.cacheRead === "number" ? record.cacheRead : 0;
  const cacheWrite = typeof record.cacheWrite === "number" ? record.cacheWrite : 0;
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return null;
  return { input, output, cacheRead, cacheWrite };
};

/** The usage panel's derivation: everything known about the thread's last
 *  assistant response — the context badge's numbers, the token breakdown
 *  (in/out/cached), the cache hit rate, the model that produced it, and the
 *  thinking level in effect then (pi's trail carries all of them: the
 *  message's `usage`/`provider`/`model`, the `model_change` entries, and
 *  the `thinking_level_change` entries). Same unknown rule as
 *  `contextUsage` — no model window, no usage yet, or a compaction since:
 *  null (pi's shell rule: context is unknown until the next response). */
export interface UsageStatus {
  /** The context badge's numbers against the model's window. */
  readonly context: {
    readonly tokens: number;
    readonly window: number;
    readonly percent: number;
  };
  /** Fresh (non-cached) input tokens of the last response. */
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  /** cacheRead / (input + cacheRead); null when there were no input tokens
   *  at all (nothing could have been served from cache). */
  readonly cacheHitRate: number | null;
  /** The last response's own model, else the last `model_change` before it,
   *  else the thread's current model. */
  readonly model: { readonly provider: string; readonly id: string } | null;
  /** The thinking level in effect for the last response (the last
   *  `thinking_level_change` at or before it), else the latest change. */
  readonly thinkingLevel: string | null;
}

/** The trail's last assistant usage, walked once into the full status
 *  (the badge and the floating usage panel read the same derivation). */
export const usageStatus = (entries: readonly EntryProjection[], model: WireModelInfo | null) => {
  const window = model?.contextWindow ?? 0;
  if (window <= 0) return null;
  let tokens: number | null = null;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let usageSeq = -1;
  let compactionSeq = -1;
  let levelAtUsage: string | null = null;
  let currentLevel: string | null = null;
  let modelAtUsage: { provider: string; id: string } | null = null;
  let currentModelChange: { provider: string; id: string } | null = null;
  for (const entry of entries) {
    const seq = entry.seq ?? -1;
    if (entry.type === "compaction") {
      compactionSeq = seq;
      continue;
    }
    if (entry.type === "thinking_level_change") {
      const level = asString(entry.thinkingLevel);
      currentLevel = level === "" ? null : level;
      continue;
    }
    if (entry.type === "model_change") {
      const provider = asString(entry.provider);
      const id = asString(entry.modelId);
      currentModelChange = provider === "" || id === "" ? null : { provider, id };
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message === undefined || message.role !== "assistant") continue;
    if (message.stopReason === "aborted" || message.stopReason === "error") continue;
    const next = usageContextTokens(message.usage);
    if (next === null) continue;
    tokens = next;
    usageSeq = seq;
    const breakdown = usageBreakdown(message.usage);
    input = breakdown?.input ?? 0;
    output = breakdown?.output ?? 0;
    cacheRead = breakdown?.cacheRead ?? 0;
    const provider = asString(message.provider);
    const id = asString(message.model);
    modelAtUsage = provider === "" || id === "" ? currentModelChange : { provider, id };
    levelAtUsage = currentLevel;
  }
  if (tokens === null || compactionSeq > usageSeq) return null;
  const percent = Math.round((tokens / window) * 100);
  const hitRateInput = input + cacheRead;
  return {
    context: { tokens, window, percent },
    input,
    output,
    cacheRead,
    cacheHitRate: hitRateInput > 0 ? cacheRead / hitRateInput : null,
    model:
      modelAtUsage ??
      currentModelChange ??
      (model === null ? null : { provider: model.provider, id: model.id }),
    thinkingLevel: levelAtUsage ?? currentLevel,
  };
};

/** The composer's context badge: the trail's last assistant usage against
 *  the model's window, or null when unknown (no model window, no usage yet,
 *  or a compaction since the last usage — pi's own shell rule: context is
 *  unknown until the next assistant response). A pure read of the trail;
 *  the console never computes thread state elsewhere (ADR 0004). */
export const contextUsage = (entries: readonly EntryProjection[], model: WireModelInfo | null) =>
  usageStatus(entries, model)?.context ?? null;

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
