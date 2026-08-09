#!/usr/bin/env node
/**
 * The saku CLI: steward of the local worker and its threads.
 *
 *   saku                           open the TUI (thread list)
 *   saku daemon start|stop|status  worker lifecycle
 *   saku list                      list threads
 *   saku new <name> [--cwd <dir>]  create a thread (--mode local|sandbox|any)
 *   saku open [thread]             launch the TUI (thread-list or a thread)
 *   saku rm <thread>               delete a thread and its session
 *
 * The daemon auto-starts on demand for every command except `daemon stop`.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";

import {
  WorkerClient,
  WireError,
  shortThreadId,
  resolveThread,
  type ThreadInfo,
  type ThreadMode,
} from "@saku/wire";
import { getWorkerSocketPath, readAuthToken } from "@saku/worker";

import { daemonStatus, ensureDaemon, spawnDaemon, stopDaemon } from "./daemon.ts";

// ---------------------------------------------------------------------------
// Console plumbing
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Connect to the worker, starting the daemon on demand — opencode-style:
 * probe first, spawn only when nothing answers, then connect. Every command
 * that talks to the worker goes through here, so a plain `saku list` boots
 * the local stack automatically, and an existing daemon is reused.
 */
const connect = async (): Promise<WorkerClient> => {
  await ensureDaemon();
  const token = readAuthToken();
  if (token === undefined) {
    throw new Error("auth token not created by the worker");
  }
  const client = new WorkerClient({ socketPath: getWorkerSocketPath(), token, role: "cli" });
  await Effect.runPromise(client.connect());
  return client;
};

function fail(error: unknown): never {
  if (error instanceof WireError) {
    console.error(`saku: ${error.message}`);
  } else if (error instanceof Error) {
    console.error(`saku: ${error.message}`);
  } else {
    console.error(`saku: ${String(error)}`);
  }
  process.exit(1);
}


const run = async <T>(effect: Effect.Effect<T, WireError, never>, label: string): Promise<T> => {
  try {
    return await Effect.runPromise(effect);
  } catch (error) {
    if (error instanceof WireError && error.code === "refused") {
      fail(new Error(`worker refused the connection (${label}) — it may have just shut down; try: saku daemon status`));
    }
    fail(error);
  }
};

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const pad = (text: string, width: number): string => text.padEnd(width).slice(0, width);

const cmdList = async (): Promise<void> => {
  const client = await connect();
  try {
    const threads = await run(client.listThreads(), "list threads");
    if (threads.length === 0) {
      console.log("no threads — create one with: saku new <name>");
      return;
    }
    console.log(pad("ID", 10) + pad("NAME", 28) + pad("MODE", 10) + pad("STATE", 12) + "CWD");
    for (const thread of threads) {
      console.log(
        pad(shortThreadId(thread.id), 10) + pad(thread.name, 28) + pad(thread.mode, 10) + pad(thread.state, 12) + thread.cwd,
      );
    }
  } finally {
    client.disconnect();
  }
};

const cmdNew = async (name: string | undefined, cwd: string, mode: ThreadMode | undefined): Promise<void> => {
  if (name === undefined || name.length === 0) {
    fail(new Error("saku new requires a name: saku new <name> [--cwd <dir>]"));
  }
  const client = await connect();
  try {
    const thread = await run(
      mode === undefined ? client.createThread(name, cwd) : client.createThread(name, cwd, mode),
      "create thread",
    );
    console.log(shortThreadId(thread.id));
  } finally {
    client.disconnect();
  }
};

const cmdOpen = async (threadArg: string | undefined): Promise<void> => {
  await ensureDaemon();
  const entry = fileURLToPath(import.meta.resolve("@saku/tui/entry"));
  const args = threadArg === undefined ? [entry] : [entry, threadArg];
  // OpenTUI's native FFI backend requires --experimental-ffi on Node.
  const child = spawn(process.execPath, ["--experimental-ffi", ...args], { stdio: "inherit", env: process.env });
  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
};

const cmdRm = async (threadArg: string | undefined): Promise<void> => {
  if (threadArg === undefined) {
    fail(new Error("saku rm requires a thread: saku rm <id-or-name>"));
  }
  const client = await connect();
  try {
    const threads = await run(client.listThreads(), "list threads");
    const resolved = resolveThread(threads, threadArg ?? "");
    if (resolved.ok) {
      await run(client.deleteThread(resolved.thread.id), "delete thread");
      console.log(`deleted ${shortThreadId(resolved.thread.id)} (${resolved.thread.name})`);
      return;
    }
    fail(new Error(resolved.message));
  } finally {
    client.disconnect();
  }
};

const cmdDaemon = async (sub: string | undefined): Promise<void> => {
  switch (sub) {
    case "start": {
      const status = await daemonStatus();
      if (status.running) {
        console.log(`already running (pid ${status.pid})`);
        return;
      }
      const pid = spawnDaemon();
      console.log(`started (pid ${pid})`);
      return;
    }
    case "stop": {
      const pid = await stopDaemon();
      console.log(pid === undefined ? "not running" : `stopped (pid ${pid})`);
      return;
    }
    case "status": {
      const status = await daemonStatus();
      if (status.running) {
        console.log(`running (pid ${status.pid}, wire ${status.version})`);
      } else {
        console.log("not running");
      }
      return;
    }
    default:
      console.error("saku daemon <start|stop|status>");
      process.exit(1);
  }
};

const usage = (): void => {
  console.log(`saku — local software factory

usage:
  saku                      open the TUI
  saku daemon <start|stop|status>
  saku list
  saku new <name> [--cwd <dir>] [--mode local|sandbox|any]
  saku open [thread]
  saku rm <thread>
`);
};

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const command = args[0];
  const rest = args.slice(1);

  const flagValue = (flags: string[], fallback: string): string => {
    const index = rest.findIndex((arg) => flags.includes(arg));
    if (index === -1) return fallback;
    return rest[index + 1] ?? fallback;
  };

  switch (command) {
    case "daemon":
      await cmdDaemon(rest[0]);
      return;
    case "list":
      await cmdList();
      return;
    case "new": {
      const name = rest[0];
      const cwd = flagValue(["--cwd", "-c"], process.cwd());
      const modeArg = flagValue(["--mode", "-m"], "local");
      const mode: ThreadMode = modeArg === "sandbox" || modeArg === "any" ? modeArg : "local";
      await cmdNew(name, cwd, mode);
      return;
    }
    case "open":
      await cmdOpen(rest[0]);
      return;
    case "rm":
    case "remove":
    case "delete":
      await cmdRm(rest[0]);
      return;
    case "help":
    case "--help":
    case "-h":
      usage();
      return;
    case undefined:
      await cmdOpen(undefined);
      return;
    default:
      console.error(`saku: unknown command "${command}"`);
      usage();
      process.exit(1);
  }
};

main().catch((error) => {
  fail(error);
});
