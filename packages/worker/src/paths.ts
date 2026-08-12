/**
 * Paths: the on-disk layout saku owns (paths.ts).
 *
 * ```
 * ~/.saku/                    <- SAKU_HOME overrides
 *   worker.url                the daemon's WebSocket URL (127.0.0.1:port)
 *   auth                      32-byte hex token, 0600 (created on first boot)
 *   worker.log                daemon log
 *   threads/<id>/
 *     thread.json             registry record (name, cwd, mode, sessionId)
 *     trail/                  the thread session's KvStore (meta + log/*)
 * ```
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Saku's home directory. Tests override with SAKU_HOME. */
export const getSakuDir = (): string =>
  process.env.SAKU_HOME !== undefined ? resolve(process.env.SAKU_HOME) : join(homedir(), ".saku");

export const getWorkerSocketPath = (): string => join(getSakuDir(), "worker.sock");
/** Where the daemon publishes its WebSocket URL (127.0.0.1:port). */
export const getWorkerUrlPath = (): string => join(getSakuDir(), "worker.url");
export const getAuthPath = (): string => join(getSakuDir(), "auth");
export const getWorkerLogPath = (): string => join(getSakuDir(), "worker.log");
export const getThreadsDir = (): string => join(getSakuDir(), "threads");

/** Per-thread directory. */
export const getThreadDir = (threadId: string): string => join(getThreadsDir(), threadId);
export const getThreadFile = (threadId: string): string =>
  join(getThreadDir(threadId), "thread.json");
/** The thread session's KvStore root (meta + log/* under it, see do-session.ts). */
export const getThreadTrailRoot = (threadId: string): string =>
  join(getThreadDir(threadId), "trail");

/** pi's agent dir: ~/.pi/agent, overridable via PI_CODING_AGENT_DIR. */
export const getAgentDir = (): string =>
  process.env.PI_CODING_AGENT_DIR !== undefined
    ? resolve(process.env.PI_CODING_AGENT_DIR)
    : join(homedir(), ".pi", "agent");

export const getAuthJsonPath = (): string => join(getAgentDir(), "auth.json");
export const getModelsJsonPath = (): string => join(getAgentDir(), "models.json");
