/**
 * The v3 pi-session reader (pi-sessions/v3.ts). pi's shell writes the v3
 * format (`CURRENT_SESSION_VERSION = 3` in pi's session-manager): one jsonl
 * file per session, a `session` header line then type-keyed entry lines
 * with no seq and no lane. pi-agent-core's own `JsonlSessionRepo` only
 * reads the newer v4 format, so this module reads v3 natively (the
 * vocabulary is frozen — pi's shell has written it for its whole life).
 *
 * The v3 → saku `SessionMutation` mapping mirrors pi's own semantics
 * (session-manager.ts / messages.ts):
 *
 * - `message`, `custom`, `model_change`, `thinking_level_change`,
 *   `active_tools_change`, `branch_summary`, `compaction` → entry
 *   mutations, seq assigned in file order
 * - `custom_message` → a message entry with `message.role: "custom"`
 *   (exactly pi's `createCustomMessage`)
 * - `session_info` → name fact; `label` → label fact. These lines are
 *   chained like entries in v3, but facts are not tree nodes in the
 *   session model — their children are re-parented to the fact's parent
 *   (the fact becomes transparent)
 * - v3 has no lane info: a final `main` lane fact pins the leaf so the
 *   first prompt on the adopted thread chains onto the last message
 * - v3 compaction entries lack `retainedTail` (v4 requires it): it is
 *   synthesized from the message path `firstKeptEntryId → leaf`, the same
 *   kept region pi's own context builder computes
 *
 * A broken parent chain or duplicate id fails the parse with the offending
 * line — better than a thread that breaks on first touch.
 */

import { Result } from "effect";
import type { CustomMessage, Entry, MessageEntry } from "@earendil-works/pi-agent-core";

import type { SessionMutation } from "../session-state.ts";
import type { JsonLine, ScannedSession, SessionHeader } from "./common.ts";
import {
  firstMessageOf,
  isMessageContent,
  isString,
  parseLine,
  parseV3Header,
  scanLines,
  sessionData,
  toEpochMs,
  PiSessionsError,
} from "./common.ts";

const invalid = (path: string, line: number, message: string) =>
  new PiSessionsError({
    kind: "invalid",
    message: `invalid pi session ${path}: line ${line}: ${message}`,
  });

/** The v3 entry line types that are tree nodes (facts and unknown types
 * are not). */
const V3_ENTRY_TYPES = new Set([
  "message",
  "model_change",
  "thinking_level_change",
  "active_tools_change",
  "branch_summary",
  "compaction",
  "custom",
]);

/** Whether a built entry object is a session entry of the frozen v3
 *  vocabulary. The discriminant and core fields (type/id/parentId) are
 *  validated here; type-specific payload fields ride along verbatim, the
 *  same trust pi's own parser applies to its files. */
const isEntry = (value: Entry | JsonLine): value is Entry => {
  if (!isString(value.type) || !V3_ENTRY_TYPES.has(value.type)) {
    return false;
  }
  if (!isString(value.id) || value.id.length === 0) {
    return false;
  }
  const { parentId } = value;
  return parentId === null || isString(parentId);
};

/** The cheap list view of a v3 file (name/count/first message — no tree). */
export const scanV3Lines = (lines: readonly string[], header: SessionHeader): ScannedSession =>
  scanLines(
    lines,
    {
      isMessage: (obj) => obj.type === "message",
      isName: (obj) => obj.type === "session_info",
      nameOf: (obj) => (isString(obj.name) ? obj.name : undefined),
    },
    header,
  );

/** The mutable state of a v3 parse, threaded through the line dispatchers. */
interface V3ParseState {
  entryOrder: Entry[];
  entriesById: Map<string, Entry>;
  factParent: Map<string, string>;
  firstMessage: string;
  lastEntryId: string | null;
  messageCount: number;
  mutations: SessionMutation[];
  name: string | undefined;
  rawLineById: Map<string, JsonLine>;
  seq: number;
}

/** Follow a fact's parent chain to the first non-fact ancestor. */
const resolveParent = (state: V3ParseState, id: string) => {
  let current = id;
  const visited = new Set<string>();
  while (state.factParent.has(current) && !visited.has(current)) {
    visited.add(current);
    const parent = state.factParent.get(current);
    if (parent === undefined) {
      break;
    }
    current = parent;
  }
  return current;
};

/** Register one v3 entry line: validate id/parent, assign seq, run the
 * builder. */
const registerEntry = (
  state: V3ParseState,
  path: string,
  obj: JsonLine,
  line: number,
  type: string,
  build: (id: string, resolvedParent: string | null, timestamp: number, seq: number) => Entry,
) => {
  const { id } = obj;
  if (!isString(id) || id.length === 0) {
    throw invalid(path, line, "entry has no id");
  }
  if (state.entriesById.has(id)) {
    throw invalid(path, line, `duplicate entry id ${id}`);
  }
  const { parentId } = obj;
  if (parentId !== null && !isString(parentId)) {
    throw invalid(path, line, "entry has an invalid parentId");
  }
  const resolvedParent = isString(parentId) ? resolveParent(state, parentId) : null;
  if (resolvedParent !== null && !state.entriesById.has(resolvedParent)) {
    throw invalid(path, line, `entry chains to unknown parent ${resolvedParent}`);
  }
  state.seq += 1;
  const entry = build(id, resolvedParent, toEpochMs(obj.timestamp), state.seq);
  state.mutations.push({ entry, kind: "entry" });
  state.entriesById.set(id, entry);
  state.entryOrder.push(entry);
  state.rawLineById.set(id, obj);
  state.lastEntryId = id;
};

/** Apply a session_info/label line (a fact); true when the line was a
 * fact. */
const applyFactLine = (path: string, line: number, obj: JsonLine, state: V3ParseState) => {
  const { type } = obj;
  if (type === "session_info") {
    const { id } = obj;
    const { parentId } = obj;
    if (!isString(id) || parentId === null || !isString(parentId)) {
      throw invalid(path, line, "session_info entry has invalid id/parentId");
    }
    if (state.factParent.has(id)) {
      throw invalid(path, line, `duplicate entry id ${id}`);
    }
    state.factParent.set(id, parentId);
    const trimmed = isString(obj.name) ? obj.name.trim() : "";
    state.seq += 1;
    state.mutations.push({ fact: "name", kind: "fact", name: trimmed, seq: state.seq });
    state.name = trimmed.length > 0 ? trimmed : undefined;
    return true;
  }
  if (type === "label") {
    const { id } = obj;
    const { parentId } = obj;
    const { targetId } = obj;
    if (!isString(id) || parentId === null || !isString(parentId) || !isString(targetId)) {
      throw invalid(path, line, "label entry has invalid id/parentId/targetId");
    }
    if (state.factParent.has(id)) {
      throw invalid(path, line, `duplicate entry id ${id}`);
    }
    state.factParent.set(id, parentId);
    state.seq += 1;
    state.mutations.push({
      fact: "label",
      kind: "fact",
      label: isString(obj.label) ? obj.label : undefined,
      seq: state.seq,
      targetId,
    });
    return true;
  }
  return false;
};

/** Replay one decoded v3 line into the parse state (throws PiSessionsError). */
const applyV3Line = (path: string, line: number, obj: JsonLine, state: V3ParseState) => {
  const { type } = obj;
  if (!isString(type)) {
    return;
  }
  if (applyFactLine(path, line, obj, state)) {
    return;
  }
  if (type === "custom_message") {
    // pi projects custom_message lines as role-custom messages
    // (createCustomMessage); in the session model they are message
    // entries, so they participate in the tree like any message.
    registerEntry(state, path, obj, line, "message", (id, resolvedParent, timestamp, seq) => {
      const message: CustomMessage = {
        content: isMessageContent(obj.content) ? obj.content : [],
        customType: isString(obj.customType) ? obj.customType : "",
        display: obj.display === true,
        role: "custom",
        timestamp,
      };
      if (obj.details !== undefined) {
        message.details = obj.details;
      }
      return { id, message, parentId: resolvedParent, seq, timestamp, type: "message" };
    });
    return;
  }
  if (V3_ENTRY_TYPES.has(type)) {
    registerEntry(state, path, obj, line, type, (id, resolvedParent, timestamp, seq) => {
      const { type: _type, id: _id, parentId: _parentId, timestamp: _timestamp, ...fields } = obj;
      const entry = { ...fields, id, parentId: resolvedParent, seq, timestamp, type };
      if (!isEntry(entry)) {
        throw invalid(path, line, "entry line has an invalid shape");
      }
      return entry;
    });
    if (type === "message") {
      state.messageCount += 1;
      if (state.firstMessage.length === 0) {
        state.firstMessage = firstMessageOf(obj) ?? "";
      }
    }
  }
  // Unknown types are skipped (pi's parser keeps them out of the tree).
};

/** The entry path from the leaf up to the root (leaf first). */
const pathFromLeaf = (state: V3ParseState): readonly Entry[] => {
  const path: Entry[] = [];
  const visited = new Set<string>();
  let current: string | null = state.lastEntryId;
  while (current !== null && !visited.has(current)) {
    visited.add(current);
    const entry = state.entriesById.get(current);
    if (entry === undefined) {
      break;
    }
    path.push(entry);
    current = entry.parentId;
  }
  return path;
};

/** Synthesize compaction retainedTail (v4 requires it; v3 files carry only
 * firstKeptEntryId). The kept region is pi's own context rule: from
 * firstKeptEntryId → leaf, the compaction entry itself excluded. */
const synthesizeRetainedTails = (state: V3ParseState, pathRootFirst: readonly Entry[]) => {
  for (const entry of state.entryOrder) {
    if (entry.type !== "compaction") {
      continue;
    }
    const compactionIdx = pathRootFirst.findIndex((e) => e.id === entry.id);
    let startIdx = compactionIdx + 1;
    const firstKept = state.rawLineById.get(entry.id)?.firstKeptEntryId;
    if (firstKept !== undefined && isString(firstKept)) {
      const firstKeptIdx = pathRootFirst.findIndex((e) => e.id === firstKept);
      if (firstKeptIdx !== -1 && firstKeptIdx < compactionIdx) {
        startIdx = firstKeptIdx;
      }
    }
    entry.retainedTail = pathRootFirst
      .slice(startIdx)
      .filter((e): e is MessageEntry => e.type === "message")
      .map((e) => e.message);
  }
};

/**
 * Parse a v3 session file into adoptable mutations. Total for well-formed
 * input; `PiSessionsError` carries the offending line when the chain cannot
 * be replayed (broken parent, duplicate id).
 */
export const parseV3 = (path: string, lines: readonly string[]) =>
  Result.try({
    catch: (error) =>
      error instanceof PiSessionsError
        ? error
        : new PiSessionsError({
            cause: error,
            kind: "invalid",
            message: `${path}: ${error instanceof Error ? error.message : String(error)}`,
          }),
    try: () => {
      const header = parseV3Header(parseLine(lines[0] ?? "") ?? {});
      if (header === undefined) {
        throw new PiSessionsError({
          kind: "invalid",
          message: `${path}: not a pi session file (expected a "session" header)`,
        });
      }
      const state: V3ParseState = {
        entriesById: new Map(),
        entryOrder: [],
        factParent: new Map(),
        firstMessage: "",
        lastEntryId: null,
        messageCount: 0,
        mutations: [],
        name: undefined,
        rawLineById: new Map(),
        seq: 0,
      };
      // Pass 1: decode lines. Fact lines (session_info/label) are chained
      // like entries in v3 but are not tree nodes in the session model —
      // remember their parent so their children re-parent through them.
      const raw: { line: number; obj: JsonLine }[] = [];
      for (let index = 1; index < lines.length; index += 1) {
        const obj = parseLine(lines[index] ?? "");
        if (obj === undefined || !isString(obj.type)) {
          continue;
        }
        raw.push({ line: index + 1, obj });
      }
      // Pass 2: build mutations in file order (seqs assigned here; v3 has none).
      for (const { line, obj } of raw) {
        applyV3Line(path, line, obj, state);
      }
      synthesizeRetainedTails(state, [...pathFromLeaf(state)].toReversed());

      // Pin the main lane so the first prompt chains onto the last message
      // (v3 has no lane info; without it the lane leaf stays null).
      if (state.lastEntryId !== null) {
        state.seq += 1;
        state.mutations.push({
          kind: "lane",
          lane: "main",
          leafId: state.lastEntryId,
          seq: state.seq,
        });
      }

      return sessionData(
        {
          createdAt: header.createdAt,
          cwd: header.cwd,
          id: header.id,
          mutations: state.mutations,
        },
        { firstMessage: state.firstMessage, name: state.name },
      );
    },
  });
