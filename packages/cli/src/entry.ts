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

import { Effect, Logger, Match, Option, Result } from "effect";

import {
  makeWireClient,
  WireError,
  shortThreadId,
  resolveThread,
  type ThreadMode,
  type WireClient,
} from "@saku/wire";

import { CliError } from "./cli-error.ts";
import { workerLifecycle } from "./daemon.ts";
import { ensureEnvConfig, envLifecycle } from "./env.ts";
import { ensure, spawn, status, stop } from "./lifecycle.ts";
import { PathsLive, type Paths } from "@saku/worker";

/**
 * The CLI's output logger: message-only lines. The CLI's stdout IS its
 * result (ids, tables, status), so Effect's logger is configured to print
 * just the message — no timestamp/level/fiber decoration.
 */
const CliLogger = Logger.withConsoleLog(
  Logger.make<unknown, string>(({ message }) =>
    Array.isArray(message) ? message.map(String).join(" ") : String(message),
  ),
);

/**
 * Connect to the worker, starting the daemon on demand — opencode-style:
 * probe first, spawn only when nothing answers, then connect. Every command
 * that talks to the worker goes through here, so a plain `saku list` boots
 * the local stack automatically, and an existing daemon is reused.
 *
 * The lifecycle's ensure already read the published url and token (it
 * waited for the daemon's probe to answer, which proves both files exist),
 * so connect uses that connection info — the storage layout stays in the
 * lifecycle module.
 */
const connect = Effect.gen(function* () {
  const lifecycle = yield* workerLifecycle();
  const connection = yield* ensure(lifecycle);
  const client = yield* makeWireClient({
    url: connection.url,
    token: connection.token,
    role: "cli",
  });
  yield* client.connect();
  return client;
});

/**
 * Print the error and exit; the only imperative boundary of the CLI. The
 * failure is always a tagged error — the process edge prints its message.
 */
const fail = (error: unknown): never => {
  const message = error instanceof Error ? error.message : String(error);
  Effect.runSync(Effect.provide(Logger.layer([CliLogger]))(Effect.logError(`saku: ${message}`)));
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

const pad = (text: string, width: number): string => text.padEnd(width).slice(0, width);

const cmdList = Effect.fn("cmdList")(function* () {
  const client = yield* connect;
  const threads = yield* run(client.listThreads(), "list threads");
  if (threads.length === 0) {
    yield* Effect.logInfo("no threads — create one with: saku new <name>");
    yield* client.disconnect();
    return;
  }
  yield* Effect.logInfo(
    pad("ID", 10) + pad("NAME", 28) + pad("MODE", 10) + pad("STATE", 12) + pad("ENV", 12) + "CWD",
  );
  for (const thread of threads) {
    yield* Effect.logInfo(
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

const cmdNew = Effect.fn("cmdNew")(function* (
  name: string | undefined,
  cwd: string,
  mode: ThreadMode | undefined,
) {
  if (name === undefined || name.length === 0) {
    return yield* Effect.fail(
      new CliError({
        code: "usage",
        message: "saku new requires a name: saku new <name> [--cwd <dir>]",
      }),
    );
  }
  const client = yield* connect;
  const thread = yield* run(
    mode === undefined
      ? client.createThread(name, { cwd })
      : client.createThread(name, { cwd, mode }),
    "create thread",
  );
  yield* Effect.logInfo(shortThreadId(thread.id));
  yield* client.disconnect();
});

const cmdRm = Effect.fn("cmdRm")(function* (threadArg: string | undefined) {
  if (threadArg === undefined) {
    return yield* Effect.fail(
      new CliError({ code: "usage", message: "saku rm requires a thread: saku rm <id-or-name>" }),
    );
  }
  const client = yield* connect;
  const threads = yield* run(client.listThreads(), "list threads");
  const resolved = resolveThread(threads, threadArg);
  if (Result.isFailure(resolved)) {
    return yield* Effect.fail(new CliError({ code: "resolution", message: resolved.failure }));
  }
  yield* run(client.deleteThread(resolved.success.id), "delete thread");
  yield* Effect.logInfo(`deleted ${shortThreadId(resolved.success.id)} (${resolved.success.name})`);
  yield* client.disconnect();
});

const fmtWhen = (ms: number): string => {
  const date = new Date(ms);
  const now = Date.now();
  const days = Math.floor((now - ms) / 86_400_000);
  if (days <= 0) return date.toLocaleTimeString();
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
};

/** saku pi list — pi's sessions on this machine, through the local daemon. */
const cmdPiList = Effect.fn("cmdPiList")(function* () {
  const client = yield* connect;
  const sessions = yield* run(client.listPiSessions(), "list pi sessions");
  if (sessions.length === 0) {
    yield* Effect.logInfo("no pi sessions found — nothing to import yet");
    yield* client.disconnect();
    return;
  }
  yield* Effect.logInfo(
    pad("ID", 14) + pad("NAME", 28) + pad("MSGS", 7) + pad("MODIFIED", 14) + "CWD",
  );
  for (const session of sessions) {
    yield* Effect.logInfo(
      pad(session.id.slice(0, 14), 14) +
        pad(session.name ?? "—", 28) +
        pad(String(session.messageCount), 7) +
        pad(fmtWhen(session.modifiedAt), 14) +
        session.cwd,
    );
  }
  yield* Effect.logInfo(`\nimport one with: saku pi import <id-or-path>`);
  yield* client.disconnect();
});

/** saku pi import <id-or-path> — adopt a pi session as a saku thread. */
const cmdPiImport = Effect.fn("cmdPiImport")(function* (arg: string | undefined) {
  if (arg === undefined || arg.length === 0) {
    return yield* Effect.fail(
      new CliError({
        code: "usage",
        message: "saku pi import requires a session: saku pi import <id-or-path>",
      }),
    );
  }
  const client = yield* connect;
  // Accept a session id, a bare filename, or a full path.
  const sessions = yield* run(client.listPiSessions(), "list pi sessions");
  const match =
    sessions.find((session) => session.id === arg) ??
    sessions.find((session) => session.path === arg) ??
    sessions.find((session) => session.path.endsWith(`/${arg}`));
  if (match === undefined) {
    return yield* Effect.fail(
      new CliError({
        code: "resolution",
        message: `no pi session matches "${arg}" — try: saku pi list`,
      }),
    );
  }
  const thread = yield* run(client.importPiSession(match.path), "import pi session");
  yield* Effect.logInfo(
    `imported ${match.id.slice(0, 12)} as ${shortThreadId(thread.id)} (${thread.name}) — continue with any saku command`,
  );
  yield* client.disconnect();
});

const cmdPi = Effect.fn("cmdPi")(function* (sub: string | undefined, arg: string | undefined) {
  yield* Match.value(sub).pipe(
    Match.withReturnType<Effect.Effect<void, WireError | CliError, Paths>>(),
    Match.when("list", () => cmdPiList()),
    Match.when("import", () => cmdPiImport(arg)),
    Match.orElse(() =>
      Effect.fail(new CliError({ code: "usage", message: "saku pi <list|import>" })),
    ),
  );
});

const cmdDaemon = Effect.fn("cmdDaemon")(function* (sub: string | undefined) {
  yield* Match.value(sub).pipe(
    Match.withReturnType<Effect.Effect<void, CliError, Paths>>(),
    Match.when("start", () =>
      Effect.gen(function* () {
        const lifecycle = yield* workerLifecycle();
        const current = yield* status(lifecycle);
        if (current.running && current.pid !== undefined) {
          yield* Effect.logInfo(`already running (pid ${current.pid})`);
          return;
        }
        const pid = yield* spawn(lifecycle);
        yield* Effect.logInfo(`started (pid ${pid})`);
      }),
    ),
    Match.when("stop", () =>
      Effect.gen(function* () {
        const lifecycle = yield* workerLifecycle();
        const pid = yield* stop(lifecycle);
        yield* Effect.logInfo(
          Option.match(pid, {
            onNone: () => "not running",
            onSome: (value) => `stopped (pid ${value})`,
          }),
        );
      }),
    ),
    Match.when("status", () =>
      Effect.gen(function* () {
        const lifecycle = yield* workerLifecycle();
        const current = yield* status(lifecycle);
        if (current.running) {
          yield* Effect.logInfo(`running (pid ${current.pid}, wire ${current.version})`);
        } else {
          yield* Effect.logInfo("not running");
        }
      }),
    ),
    Match.orElse(() =>
      Effect.fail(new CliError({ code: "usage", message: "saku daemon <start|stop|status>" })),
    ),
  );
});

const cmdEnv = Effect.fn("cmdEnv")(function* (sub: string | undefined, hubUrl: string | undefined) {
  yield* Match.value(sub).pipe(
    Match.withReturnType<Effect.Effect<void, CliError, Paths>>(),
    Match.when("start", () =>
      Effect.gen(function* () {
        const config = yield* ensureEnvConfig(hubUrl).pipe(
          Effect.mapError(
            (error) =>
              new CliError({
                code: "env_config",
                message: `failed to write the env config: ${error instanceof Error ? error.message : String(error)}`,
                cause: error,
              }),
          ),
        );
        const lifecycle = yield* envLifecycle(hubUrl);
        const current = yield* status(lifecycle);
        if (current.running && current.pid !== undefined) {
          yield* Effect.logInfo(`env already running (pid ${current.pid})`);
          return;
        }
        const connection = yield* ensure(lifecycle);
        const relay = config.hubUrl !== undefined ? ` (relay to ${config.hubUrl})` : "";
        yield* Effect.logInfo(`env started (pid ${connection.pid}, ${connection.url})${relay}`);
        return;
      }),
    ),
    Match.when("stop", () =>
      Effect.gen(function* () {
        const lifecycle = yield* envLifecycle();
        const pid = yield* stop(lifecycle);
        yield* Effect.logInfo(
          Option.match(pid, {
            onNone: () => "env not running",
            onSome: (value) => `env stopped (pid ${value})`,
          }),
        );
      }),
    ),
    Match.when("status", () =>
      Effect.gen(function* () {
        const lifecycle = yield* envLifecycle();
        const current = yield* status(lifecycle);
        if (current.running) {
          yield* Effect.logInfo(
            `running (pid ${current.pid}, protocol ${current.version}, cwd ${current.cwd})`,
          );
        } else {
          yield* Effect.logInfo("not running");
        }
      }),
    ),
    Match.orElse(() =>
      Effect.fail(
        new CliError({ code: "usage", message: "saku env <start|stop|status> [--hub <url>]" }),
      ),
    ),
  );
});

const usage = (): string => `saku — local software factory

usage:
  saku daemon <start|stop|status>
  saku env <start|stop|status> [--hub <url>]
  saku list
  saku new <name> [--cwd <dir>] [--mode local|sandbox|any]
  saku rm <thread>
  saku pi list
  saku pi import <id-or-path>
`;

const main = Effect.fn("main")(function* () {
  const args = process.argv.slice(2);
  const command = args[0];
  const rest = args.slice(1);

  const flagValue = (flags: string[], fallback: string): string => {
    const index = rest.findIndex((arg) => flags.includes(arg));
    if (index === -1) return fallback;
    return rest[index + 1] ?? fallback;
  };

  yield* Match.value(command).pipe(
    Match.withReturnType<Effect.Effect<void, WireError | CliError, Paths>>(),
    Match.when("daemon", () => cmdDaemon(rest[0])),
    Match.when("env", () =>
      cmdEnv(rest[0], rest.includes("--hub") ? rest[rest.indexOf("--hub") + 1] : undefined),
    ),
    Match.when("list", () => cmdList()),
    Match.when("new", () => {
      const name = rest[0];
      const cwd = flagValue(["--cwd", "-c"], process.cwd());
      const modeArg = flagValue(["--mode", "-m"], "local");
      const mode: ThreadMode = modeArg === "sandbox" || modeArg === "any" ? modeArg : "local";
      return cmdNew(name, cwd, mode);
    }),
    Match.when("pi", () => cmdPi(rest[0], rest[1])),
    Match.whenOr("rm", "remove", "delete", () => cmdRm(rest[0])),
    Match.whenOr("help", "--help", "-h", () => Effect.logInfo(usage())),
    Match.orElse((command) =>
      Effect.fail(new CliError({ code: "usage", message: `unknown command "${command}"` })),
    ),
  );
});

Effect.runPromise(
  Effect.provide(Logger.layer([CliLogger]))(Effect.provide(PathsLive)(main())),
).catch(fail);
