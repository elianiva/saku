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
import type { Json } from "effect/Schema";
import { asString } from "./thread/format.ts";
import type { EntryProjection, MessageProjection } from "./thread/projection.ts";

const modeIcons = {
  any: "shuffle",
  local: "laptop",
  sandbox: "box",
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
  if (picker.entries._tag !== "Success") {
    return [];
  }
  const needle = picker.filter.trim().toLowerCase();
  const rows: PickerRow[] = [];
  if (picker.parent !== null) {
    rows.push({ kind: "up" });
  }
  for (const entry of picker.entries.data) {
    if (needle.length > 0 && !entry.name.toLowerCase().includes(needle)) {
      continue;
    }
    rows.push({ entry, kind: "dir" });
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
  idle: { icon: "circle", title: "idle", tone: "text-muted" },
  interrupted: {
    icon: "circleAlert",
    title: "interrupted — recovery on next command",
    tone: "text-rose",
  },
  working: { icon: "loaderCircle", title: "working", tone: "text-gold animate-spin" },
} satisfies Record<ThreadState, StatePresentation>;

export const statePresentation = (state: ThreadState) => statePresentations[state];

/** How the rail draws a thread's env: icon, tone, title. */
export interface EnvPresentation {
  readonly icon: IconName;
  readonly tone: string;
  readonly title: string;
}

const envPresentations = {
  error: { icon: "circleX", title: "env error — next prompt retries", tone: "text-love" },
  provisioning: {
    icon: "loaderCircle",
    title: "env provisioning",
    tone: "text-gold animate-spin",
  },
  ready: { icon: "circleCheck", title: "env ready", tone: "text-foam" },
  stopped: { icon: "circleStop", title: "env stopped — resumes on prompt", tone: "text-muted" },
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
  if (q === "") {
    return models;
  }
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
export const contextTone = (percent: number) => {
  if (percent >= CONTEXT_CRITICAL_PERCENT) {
    return "text-love";
  }
  if (percent >= CONTEXT_WARNING_PERCENT) {
    return "text-gold";
  }
  return "text-foam";
};

/** A usage payload as a record (the message's `usage` after boundary
 *  decoding — ADR 0005). */
interface UsageRecord {
  readonly [key: string]: Json;
}

const isUsageRecord = (usage: Json | undefined): usage is UsageRecord =>
  typeof usage === "object" && usage !== null;

const isNumber = (value: Json | undefined): value is number => typeof value === "number";

/** A usage field as a number, absent fields counting as 0. */
const num = (usage: UsageRecord, key: string) => {
  const value = usage[key];
  return isNumber(value) ? value : 0;
};

/** pi's per-request context size from a usage payload: the native
 *  `totalTokens`, else the component sum (pi's own shell rule, decoded in
 *  the console — ADR 0005). Null when the payload carries neither. */
export const usageContextTokens = (usage: Json | undefined) => {
  if (!isUsageRecord(usage)) {
    return null;
  }
  if (isNumber(usage.totalTokens)) {
    return usage.totalTokens;
  }
  const tokens = num(usage, "input") + num(usage, "cacheRead") + num(usage, "cacheWrite");
  return tokens > 0 ? tokens : null;
};

/** A pi usage payload's token breakdown (input/output/cacheRead/cacheWrite),
 *  decoded defensively; null when the payload carries no components at all. */
export const usageBreakdown = (usage: Json | undefined) => {
  if (!isUsageRecord(usage)) {
    return null;
  }
  const input = num(usage, "input");
  const output = num(usage, "output");
  const cacheRead = num(usage, "cacheRead");
  const cacheWrite = num(usage, "cacheWrite");
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) {
    return null;
  }
  return { cacheRead, cacheWrite, input, output };
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

/** The walking accumulator for the last-usage scan. */
interface UsageWalk {
  cacheRead: number;
  compactionSeq: number;
  currentLevel: string | null;
  currentModelChange: { provider: string; id: string } | null;
  input: number;
  levelAtUsage: string | null;
  modelAtUsage: { provider: string; id: string } | null;
  output: number;
  tokens: number | null;
  usageSeq: number;
}

/** Fold one assistant message's usage into the walk. */
const applyUsageMessage = (acc: UsageWalk, message: MessageProjection, seq: number) => {
  const next = usageContextTokens(message.usage);
  if (next === null) {
    return;
  }
  acc.tokens = next;
  acc.usageSeq = seq;
  const breakdown = usageBreakdown(message.usage);
  acc.input = breakdown?.input ?? 0;
  acc.output = breakdown?.output ?? 0;
  acc.cacheRead = breakdown?.cacheRead ?? 0;
  const provider = asString(message.provider);
  const id = asString(message.model);
  acc.modelAtUsage = provider === "" || id === "" ? acc.currentModelChange : { id, provider };
  acc.levelAtUsage = acc.currentLevel;
};

/** Fold one trail entry into the walk (compactions, level/model changes,
 *  and assistant messages with usage). */
const foldUsageEntry = (acc: UsageWalk, entry: EntryProjection) => {
  const seq = entry.seq ?? -1;
  if (entry.type === "compaction") {
    acc.compactionSeq = seq;
    return;
  }
  if (entry.type === "thinking_level_change") {
    const level = asString(entry.thinkingLevel);
    acc.currentLevel = level === "" ? null : level;
    return;
  }
  if (entry.type === "model_change") {
    const provider = asString(entry.provider);
    const id = asString(entry.modelId);
    acc.currentModelChange = provider === "" || id === "" ? null : { id, provider };
    return;
  }
  if (entry.type !== "message") {
    return;
  }
  const { message } = entry;
  if (message === undefined || message.role !== "assistant") {
    return;
  }
  if (message.stopReason === "aborted" || message.stopReason === "error") {
    return;
  }
  applyUsageMessage(acc, message, seq);
};

/** The trail's last assistant usage, walked once into the full status
 *  (the badge and the floating usage panel read the same derivation). */
export const usageStatus = (entries: readonly EntryProjection[], model: WireModelInfo | null) => {
  const window = model?.contextWindow ?? 0;
  if (window <= 0) {
    return null;
  }
  const acc: UsageWalk = {
    cacheRead: 0,
    compactionSeq: -1,
    currentLevel: null,
    currentModelChange: null,
    input: 0,
    levelAtUsage: null,
    modelAtUsage: null,
    output: 0,
    tokens: null,
    usageSeq: -1,
  };
  for (const entry of entries) {
    foldUsageEntry(acc, entry);
  }
  if (acc.tokens === null || acc.compactionSeq > acc.usageSeq) {
    return null;
  }
  const percent = Math.round((acc.tokens / window) * 100);
  const hitRateInput = acc.input + acc.cacheRead;
  return {
    cacheHitRate: hitRateInput > 0 ? acc.cacheRead / hitRateInput : null,
    cacheRead: acc.cacheRead,
    context: { percent, tokens: acc.tokens, window },
    input: acc.input,
    model:
      acc.modelAtUsage ??
      acc.currentModelChange ??
      (model === null ? null : { id: model.id, provider: model.provider }),
    output: acc.output,
    thinkingLevel: acc.levelAtUsage ?? acc.currentLevel,
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
    const { source } = thread;
    if (source !== undefined && source.kind === "pi") {
      adopted.add(source.path);
    }
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
export const projectName = (path: string) =>
  path.split("/").findLast((part) => part !== "") ?? path;

/** A compact relative time ("just now", "5m", "3h", "2d", then a date). */
export const relativeTime = (ms: number) => {
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d ago`;
  }
  return new Date(ms).toLocaleDateString();
};

/** The header's state/env tone (the shared derivation). */
const stateTone = (state: ThreadState | undefined, env: ThreadEnvState | undefined) => {
  if (state === "working") {
    return "text-gold";
  }
  if (env === "error") {
    return "text-love";
  }
  return "text-subtle";
};

/** The header's state/env presentation: values and tone. */
export const headerState = (state: ThreadState | undefined, env: ThreadEnvState | undefined) => ({
  env,
  state,
  tone: stateTone(state, env),
});
