#!/usr/bin/env node
/**
 * The saku CLI: steward of the local worker and its threads.
 *
 *   saku daemon start|stop|status  worker lifecycle
 *   saku list                      list threads
 *   saku new <name> [--cwd <dir>]  create a thread (--mode local|sandbox|any)
 *   saku rm <thread>               delete a thread and its session
 *
 * The daemon auto-starts on demand for every command except `daemon stop`.
 */

import { Effect, Option, Result } from "effect";

import {
  makeWireClient,
  WireError,
  shortThreadId,
  resolveThread,
  type ThreadMode,
  type WireClient,
} from "@saku/wire";

import { CliError } from "./cli-error.ts";
import {
  daemonStatus,
  ensureDaemon,
  readWorkerToken,
  readWorkerUrl,
  spawnDaemon,
  stopDaemon,
} from "./daemon.ts";
import { ensureEnvConfig, ensureEnvDaemon, envStatus, readEnvUrl, stopEnvDaemon } from "./env.ts";

// ---------------------------------------------------------------------------
// Console plumbing
// ---------------------------------------------------------------------------

/**
 * Connect to the worker, starting the daemon on demand — opencode-style:
 * probe first, spawn only when nothing answers, then connect. Every command
 * that talks to the worker goes through here, so a plain `saku list` boots
 * the local stack automatically, and an existing daemon is reused.
 */
const connect = (): Effect.Effect<WireClient, CliError | WireError, never> =>
  Effect.gen(function* () {
    yield* ensureDaemon();
    const url = yield* readWorkerUrl();
    if (Option.isNone(url)) {
      return yield* Effect.fail(
        new CliError({
          code: "missing_url",
          message: "the worker did not publish its url",
        }),
      );
    }
    const token = yield* readWorkerToken();
    if (Option.isNone(token)) {
      return yield* Effect.fail(
        new CliError({
          code: "missing_token",
          message: "auth token not created by the worker",
        }),
      );
    }
    const client = yield* makeWireClient({ url: url.value, token: token.value, role: "cli" });
    yield* client.connect();
    return client;
  });

/**
 * Print the error and exit; the only imperative boundary of the CLI. The
 * failure is always a tagged error — the process edge prints its message.
 */
const fail = (error: unknown): never => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`saku: ${message}`);
  process.exit(1);
};

/** Give connection-refused errors a steer, keep everything else as-is. */
const run = <T>(
  effect: Effect.Effect<T, WireError, never>,
  label: string,
): Effect.Effect<T, WireError, never> =>
  effect.pipe(
    Effect.catchIf(
      (error): error is WireError => error instanceof WireError && error.code === "refused",
      () =>
        Effect.fail(
          new WireError({
            code: "refused",
            message: `worker refused the connection (${label}) — it may have just shut down; try: saku daemon status`,
          }),
        ),
    ),
  );

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const pad = (text: string, width: number): string => text.padEnd(width).slice(0, width);

const cmdList = (): Effect.Effect<void, WireError | CliError, never> =>
  Effect.gen(function* () {
    const client = yield* connect();
    const threads = yield* run(client.listThreads(), "list threads");
    if (threads.length === 0) {
      console.log("no threads — create one with: saku new <name>");
      yield* client.disconnect();
      return;
    }
    console.log(
      pad("ID", 10) + pad("NAME", 28) + pad("MODE", 10) + pad("STATE", 12) + pad("ENV", 12) + "CWD",
    );
    for (const thread of threads) {
      console.log(
        pad(shortThreadId(thread.id), 10) +
          pad(thread.name, 28) +
          pad(thread.mode, 10) +
          pad(thread.state, 12) +
          pad(thread.env, 12) +
          (thread.cwd ?? "—"),
      );
    }
    yield* client.disconnect();
  });

const cmdNew = (
  name: string | undefined,
  cwd: string,
  mode: ThreadMode | undefined,
): Effect.Effect<void, WireError | CliError, never> =>
  Effect.gen(function* () {
    if (name === undefined || name.length === 0) {
      return yield* Effect.fail(
        new CliError({
          code: "usage",
          message: "saku new requires a name: saku new <name> [--cwd <dir>]",
        }),
      );
    }
    const client = yield* connect();
    const thread = yield* run(
      mode === undefined
        ? client.createThread(name, { cwd })
        : client.createThread(name, { cwd, mode }),
      "create thread",
    );
    console.log(shortThreadId(thread.id));
    yield* client.disconnect();
  });

const cmdRm = (threadArg: string | undefined): Effect.Effect<void, WireError | CliError, never> =>
  Effect.gen(function* () {
    if (threadArg === undefined) {
      return yield* Effect.fail(
        new CliError({ code: "usage", message: "saku rm requires a thread: saku rm <id-or-name>" }),
      );
    }
    const client = yield* connect();
    const threads = yield* run(client.listThreads(), "list threads");
    const resolved = resolveThread(threads, threadArg);
    if (Result.isFailure(resolved)) {
      return yield* Effect.fail(new CliError({ code: "resolution", message: resolved.failure }));
    }
    yield* run(client.deleteThread(resolved.success.id), "delete thread");
    console.log(`deleted ${shortThreadId(resolved.success.id)} (${resolved.success.name})`);
    yield* client.disconnect();
  });

const cmdDaemon = (sub: string | undefined): Effect.Effect<void, Error, never> =>
  Effect.gen(function* () {
    switch (sub) {
      case "start": {
        const status = yield* daemonStatus();
        if (status.running && status.pid !== undefined) {
          console.log(`already running (pid ${status.pid})`);
          return;
        }
        const pid = yield* spawnDaemon();
        console.log(`started (pid ${pid})`);
        return;
      }
      case "stop": {
        const pid = yield* stopDaemon();
        console.log(
          Option.match(pid, {
            onNone: () => "not running",
            onSome: (value) => `stopped (pid ${value})`,
          }),
        );
        return;
      }
      case "status": {
        const status = yield* daemonStatus();
        if (status.running) {
          console.log(`running (pid ${status.pid}, wire ${status.version})`);
        } else {
          console.log("not running");
        }
        return;
      }
      default:
        return yield* Effect.fail(
          new CliError({ code: "usage", message: "saku daemon <start|stop|status>" }),
        );
    }
  });

const cmdEnv = (
  sub: string | undefined,
  hubUrl: string | undefined,
): Effect.Effect<void, Error, never> =>
  Effect.gen(function* () {
    switch (sub) {
      case "start": {
        const config = yield* ensureEnvConfig(hubUrl);
        const status = yield* envStatus();
        if (status.running && status.pid !== undefined) {
          console.log(`env already running (pid ${status.pid})`);
          return;
        }
        const pid = yield* ensureEnvDaemon(config);
        const url = yield* readEnvUrl();
        const relay = config.hubUrl !== undefined ? ` (relay to ${config.hubUrl})` : "";
        console.log(
          `env started (pid ${pid}, ${Option.isSome(url) ? url.value : "no url"})${relay}`,
        );
        return;
      }
      case "stop": {
        const pid = yield* stopEnvDaemon();
        console.log(
          Option.match(pid, {
            onNone: () => "env not running",
            onSome: (value) => `env stopped (pid ${value})`,
          }),
        );
        return;
      }
      case "status": {
        const status = yield* envStatus();
        if (status.running) {
          console.log(`running (pid ${status.pid}, protocol ${status.version}, cwd ${status.cwd})`);
        } else {
          console.log("not running");
        }
        return;
      }
      default:
        return yield* Effect.fail(
          new CliError({ code: "usage", message: "saku env <start|stop|status> [--hub <url>]" }),
        );
    }
  });

const usage = (): void => {
  console.log(`saku — local software factory

usage:
  saku daemon <start|stop|status>
  saku env <start|stop|status> [--hub <url>]
  saku list
  saku new <name> [--cwd <dir>] [--mode local|sandbox|any]
  saku rm <thread>
`);
};

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const main = (): Effect.Effect<void, WireError | Error, never> =>
  Effect.gen(function* () {
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
        yield* cmdDaemon(rest[0]);
        return;
      case "env":
        yield* cmdEnv(
          rest[0],
          rest.includes("--hub") ? rest[rest.indexOf("--hub") + 1] : undefined,
        );
        return;
      case "list":
        yield* cmdList();
        return;
      case "new": {
        const name = rest[0];
        const cwd = flagValue(["--cwd", "-c"], process.cwd());
        const modeArg = flagValue(["--mode", "-m"], "local");
        const mode: ThreadMode = modeArg === "sandbox" || modeArg === "any" ? modeArg : "local";
        yield* cmdNew(name, cwd, mode);
        return;
      }
      case "rm":
      case "remove":
      case "delete":
        yield* cmdRm(rest[0]);
        return;
      case "help":
      case "--help":
      case "-h":
        usage();
        return;
      default:
        return yield* Effect.fail(
          new CliError({ code: "usage", message: `unknown command "${command}"` }),
        );
    }
  });

Effect.runPromise(main()).catch(fail);
