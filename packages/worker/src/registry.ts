/**
 * Registry: the durable list of threads (registry.ts).
 *
 * Threads are the layer pi lacks — a pi session has no name, no working
 * directory, no hands policy, no lifecycle state. The registry is the
 * daemon's in-memory view persisted to `threads/<id>/thread.json` on every
 * mutation. Writes are atomic (write temp file, rename).
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ThreadInfo, ThreadMode, ThreadState } from "@saku/wire";

import { getThreadDir, getThreadFile, getThreadSessionsRoot } from "./paths.ts";

export interface ThreadRecord {
  /** Full uuid (unhyphenated). Consoles see an 8-char prefix. */
  id: string;
  name: string;
  cwd: string;
  /** Hands policy, pinned at creation. */
  mode: ThreadMode;
  createdAt: number;
  /** Pi session id, stable across daemon restarts; set on first touch. */
  sessionId: string | null;
}

/**
 * Registry of thread records, kept in memory and persisted per-thread.
 * Loaded at daemon boot; `thread_changed` broadcasts carry the diff out.
 */
export class ThreadRegistry {
  private readonly records = new Map<string, ThreadRecord>();
  /** Liveness state derived by hosts; not persisted (re-derived at boot). */
  private readonly states = new Map<string, ThreadState>();

  /** Scan the threads directory; a thread with no record file was never touched. */
  static load(): ThreadRegistry {
    const registry = new ThreadRegistry();
    let names: string[] = [];
    try {
      names = readdirSync(getThreadDir(""));
    } catch {
      // No threads directory yet — empty registry.
      return registry;
    }
    for (const name of names) {
      if (!/^[0-9a-f]{32}$/u.test(name)) continue;
      try {
        const record = JSON.parse(readFileSync(getThreadFile(name), "utf8")) as ThreadRecord;
        registry.records.set(record.id, record);
        // Every thread starts idle; hosts derive interrupted/crashed on touch.
        registry.states.set(record.id, "idle");
      } catch {
        // Corrupt record file: skip. The thread directory remains on disk.
      }
    }
    return registry;
  }

  list(): ThreadRecord[] {
    return [...this.records.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(threadId: string): ThreadRecord | undefined {
    return this.records.get(threadId);
  }

  /** Create a thread record and persist it. */
  create(input: { name: string; cwd: string; mode?: ThreadMode }): ThreadRecord {
    const record: ThreadRecord = {
      id: randomUUID().replaceAll("-", ""),
      name: input.name,
      cwd: input.cwd,
      mode: input.mode ?? "local",
      createdAt: Date.now(),
      sessionId: null,
    };
    this.records.set(record.id, record);
    this.states.set(record.id, "idle");
    this.persist(record);
    return record;
  }

  update(threadId: string, patch: Partial<Pick<ThreadRecord, "name" | "sessionId">>): ThreadRecord | undefined {
    const record = this.records.get(threadId);
    if (record === undefined) return undefined;
    if (patch.name !== undefined) record.name = patch.name;
    if (patch.sessionId !== undefined) record.sessionId = patch.sessionId;
    this.persist(record);
    return record;
  }

  setState(threadId: string, state: ThreadState): void {
    this.states.set(threadId, state);
  }

  /** Delete the record AND the thread's directory (sessions included). */
  delete(threadId: string): boolean {
    const had = this.records.delete(threadId);
    this.states.delete(threadId);
    if (had) {
      try {
        rmSync(getThreadDir(threadId), { recursive: true, force: true });
      } catch {
        // Best-effort removal; the registry entry is gone either way.
      }
    }
    return had;
  }

  /** Wire projection: registry view + derived state. */
  toInfo(threadId: string, tailSeq: number): ThreadInfo | undefined {
    const record = this.records.get(threadId);
    if (record === undefined) return undefined;
    return {
      id: record.id,
      name: record.name,
      cwd: record.cwd,
      mode: record.mode,
      state: this.states.get(threadId) ?? "idle",
      sessionId: record.sessionId,
      tailSeq,
    };
  }

  private persist(record: ThreadRecord): void {
    const dir = getThreadDir(record.id);
    mkdirSync(dir, { recursive: true });
    const path = getThreadFile(record.id);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
    renameSync(tmp, path);
  }
}

/** Sessions root for a thread's JsonlSessionRepo. */
export const threadSessionsRoot = (threadId: string): string => {
  mkdirSync(getThreadDir(threadId), { recursive: true });
  return getThreadSessionsRoot(threadId);
};
