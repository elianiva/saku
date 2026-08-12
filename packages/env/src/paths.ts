/**
 * Paths: the on-disk layout the env daemon owns (paths.ts) — a sibling of
 * the worker's layout under `SAKU_HOME` (`~/.saku` by default).
 *
 * ```
 * ~/.saku/
 *   env.url     the daemon's WebSocket URL (127.0.0.1:port)
 *   env.log     daemon log (the CLI spawns it with this as stdout)
 *   env.json    daemon identity: {envId, token, hubUrl?} (CLI-managed)
 * ```
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Saku's home directory. Tests override with SAKU_HOME. */
export const getSakuDir = (): string =>
  process.env.SAKU_HOME !== undefined ? resolve(process.env.SAKU_HOME) : join(homedir(), ".saku");

/** Where the env daemon publishes its WebSocket URL (127.0.0.1:port). */
export const getEnvUrlPath = (): string => join(getSakuDir(), "env.url");
export const getEnvLogPath = (): string => join(getSakuDir(), "env.log");
/** The daemon's identity: envId + env token (+ the hub the CLI registered with). */
export const getEnvConfigPath = (): string => join(getSakuDir(), "env.json");
