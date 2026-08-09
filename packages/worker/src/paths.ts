/**
 * Paths: the on-disk layout saku owns (paths.ts).
 *
 * ```
 * ~/.saku/                    <- SAKU_HOME overrides
 *   worker.sock               unix socket for consoles
 *   auth                      32-byte hex token, 0600 (created on first boot)
 *   worker.log                daemon log
 *   threads/<id>/
 *     thread.json             registry record (name, cwd, mode, sessionId)
 *     sessions/               JsonlSessionRepo root for the thread's session
 * ```
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Saku's home directory. Tests override with SAKU_HOME. */
export const getSakuDir = (): string =>
  process.env.SAKU_HOME !== undefined ? resolve(process.env.SAKU_HOME) : join(homedir(), ".saku");

export const getWorkerSocketPath = (): string => join(getSakuDir(), "worker.sock");
export const getAuthPath = (): string => join(getSakuDir(), "auth");
export const getWorkerLogPath = (): string => join(getSakuDir(), "worker.log");
export const getThreadsDir = (): string => join(getSakuDir(), "threads");

/** Per-thread directory; also the sessions root for its JsonlSessionRepo. */
export const getThreadDir = (threadId: string): string => join(getThreadsDir(), threadId);
export const getThreadFile = (threadId: string): string => join(getThreadDir(threadId), "thread.json");
export const getThreadSessionsRoot = (threadId: string): string => join(getThreadDir(threadId), "sessions");

/** pi's agent dir: ~/.pi/agent, overridable via PI_CODING_AGENT_DIR. */
export const getAgentDir = (): string =>
  process.env.PI_CODING_AGENT_DIR !== undefined
    ? resolve(process.env.PI_CODING_AGENT_DIR)
    : join(homedir(), ".pi", "agent");

export const getAuthJsonPath = (): string => join(getAgentDir(), "auth.json");
export const getModelsJsonPath = (): string => join(getAgentDir(), "models.json");
