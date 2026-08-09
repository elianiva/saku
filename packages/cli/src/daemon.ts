/**
 * Daemon stewardship (daemon.ts): spawn, probe, and stop the worker.
 *
 * The daemon is a detached `node` child running `@saku/worker/daemon`, its
 * stdout/stderr appended to `~/.saku/worker.log`. Status is probed over the
 * wire (hello_ok carries the pid); stopping sends SIGTERM to that pid.
 */

import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";

import { WorkerClient } from "@saku/wire";
import { ensureSakuDirs, getWorkerLogPath, getWorkerSocketPath, readAuthToken } from "@saku/worker";

export const resolveDaemonEntry = (): string => fileURLToPath(import.meta.resolve("@saku/worker/daemon"));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface DaemonStatus {
  readonly running: boolean;
  readonly pid?: number;
  readonly version?: string;
}

/** Probe the daemon over the wire; never throws, never leaks a socket. */
export const daemonStatus = async (): Promise<DaemonStatus> => {
  const token = readAuthToken();
  if (token === undefined) return { running: false };
  const client = new WorkerClient({ socketPath: getWorkerSocketPath(), token, role: "cli" });
  const hello = await new Promise<unknown>((resolve) => {
    client.on("hello_ok", resolve);
    void Effect.runPromise(Effect.timeout(client.connect(), "2 seconds")).catch(() => {
      resolve(undefined);
    });
  });
  client.disconnect();
  if (hello === undefined) return { running: false };
  const h = hello as { pid: number; version: string };
  return { running: true, pid: h.pid, version: h.version };
};

/** Spawn a detached daemon; returns its pid (0 when spawn failed). */
export const spawnDaemon = (): number => {
  const entry = resolveDaemonEntry();
  // A fresh home has no ~/.saku yet; the log fd needs the directory.
  ensureSakuDirs();
  const logFd = openSync(getWorkerLogPath(), "a");
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  return child.pid ?? 0;
};

/** Spawn if needed and wait until the socket answers. Returns the pid. */
export const ensureDaemon = async (): Promise<number> => {
  const status = await daemonStatus();
  if (status.running) return status.pid!;
  const pid = spawnDaemon();
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    const now = await daemonStatus();
    if (now.running) return now.pid!;
  }
  throw new Error(`daemon did not come up (spawned pid ${pid}); see ${getWorkerLogPath()}`);
};

/** Stop the daemon; returns the pid that was stopped, or undefined. */
export const stopDaemon = async (): Promise<number | undefined> => {
  const status = await daemonStatus();
  if (!status.running || status.pid === undefined) return undefined;
  try {
    process.kill(status.pid, "SIGTERM");
  } catch {
    // Already gone.
    return status.pid;
  }
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    if (!(await daemonStatus()).running) break;
  }
  return status.pid;
};
