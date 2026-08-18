#!/usr/bin/env node
/**
 * The saku CLI: steward of the local worker and its threads.
 *
 *   saku daemon start|stop|restart|status  worker lifecycle
 *   saku list                      list threads (archived marked)
 *   saku new <name> [--cwd <dir>]  create a thread (--mode local|sandbox|any)
 *   saku rm <thread>               delete a thread and its session
 *   saku archive|unarchive <t>     the visibility lifecycle (CONTEXT.md: Archive)
 *   saku project add|list|remove   the session window's scope (CONTEXT.md: Project)
 *   saku pi list [project]         the added projects' pi sessions
 *   saku pi import <id-or-path>    adopt a pi session as a thread
 *
 * The daemon auto-starts on demand for every command except `daemon stop`.
 */

import { Effect, FileSystem, Logger, Match, Option, Result } from "effect";
import { NodeFileSystem } from "@effect/platform-node";

import { WireClient, WireError, shortThreadId, resolveThread } from "@saku/wire";
import type { ThreadMode } from "@saku/wire";

import { CliError } from "./cli-error.ts";
import { workerLifecycle } from "./daemon.ts";
import { ensureEnvConfig, envLifecycle } from "./env.ts";
import { ensure, spawn, status, stop } from "./lifecycle.ts";
import { PathsLive } from "@saku/worker";
import type { Paths } from "@saku/worker";

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
  const client = yield* WireClient.make({
    role: "cli",
    token: connection.token,
    url: connection.url,
  });
  yield* client.connect();
  return client;
});

/**
 * Print the error and exit; the only imperative boundary of the CLI. The
 * failure is always a tagged error — the process edge prints its message.
 */
const fail = (cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  Effect.runSync(Effect.provide(Logger.layer([CliLogger]))(Effect.logError(`saku: ${message}`)));
  process.exit(1);
};

const pad = (text: string, width: number) => text.padEnd(width).slice(0, width);

const cmdList = Effect.fn("cmdList")(function* () {
  const client = yield* connect;
  const threads = yield* client.listThreads().pipe(
    Effect.catchIf(
      (error): error is WireError => error instanceof WireError && error.code === "refused",
      () =>
        Effect.fail(
          new WireError({
            code: "refused",
            message: `worker refused the connection (list threads) — it may have just shut down; try: saku daemon status`,
          }),
        ),
    ),
  );
  if (threads.length === 0) {
    yield* Effect.logInfo("no threads — create one with: saku new <name>");
    yield* client.disconnect();
    return;
  }
  yield* Effect.logInfo(
    `${pad("ID", 10) + pad("NAME", 28) + pad("MODE", 10) + pad("STATE", 12) + pad("ENV", 12)}CWD`,
  );
  for (const thread of threads) {
    yield* Effect.logInfo(
      pad(shortThreadId(thread.id), 10) +
        pad(thread.name + (thread.archivedAt === null ? "" : " [archived]"), 28) +
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
    yield* Effect.fail(
      new CliError({
        code: "usage",
        message: "saku new requires a name: saku new <name> [--cwd <dir>]",
      }),
    );
    return;
  }
  const client = yield* connect;
  const thread = yield* (
    mode === undefined
      ? client.createThread(name, { cwd })
      : client.createThread(name, { cwd, mode })
  ).pipe(
    Effect.catchIf(
      (error): error is WireError => error instanceof WireError && error.code === "refused",
      () =>
        Effect.fail(
          new WireError({
            code: "refused",
            message: `worker refused the connection (create thread) — it may have just shut down; try: saku daemon status`,
          }),
        ),
    ),
  );
  yield* Effect.logInfo(shortThreadId(thread.id));
  yield* client.disconnect();
});

const cmdRm = Effect.fn("cmdRm")(function* (threadArg: string | undefined) {
  if (threadArg === undefined) {
    yield* Effect.fail(
      new CliError({ code: "usage", message: "saku rm requires a thread: saku rm <id-or-name>" }),
    );
    return;
  }
  const client = yield* connect;
  const threads = yield* client.listThreads().pipe(
    Effect.catchIf(
      (error): error is WireError => error instanceof WireError && error.code === "refused",
      () =>
        Effect.fail(
          new WireError({
            code: "refused",
            message: `worker refused the connection (list threads) — it may have just shut down; try: saku daemon status`,
          }),
        ),
    ),
  );
  const resolved = resolveThread(threads, threadArg);
  if (Result.isFailure(resolved)) {
    yield* Effect.fail(new CliError({ code: "resolution", message: resolved.failure }));
    return;
  }
  yield* client.deleteThread(resolved.success.id).pipe(
    Effect.catchIf(
      (error): error is WireError => error instanceof WireError && error.code === "refused",
      () =>
        Effect.fail(
          new WireError({
            code: "refused",
            message: `worker refused the connection (delete thread) — it may have just shut down; try: saku daemon status`,
          }),
        ),
    ),
  );
  yield* Effect.logInfo(`deleted ${shortThreadId(resolved.success.id)} (${resolved.success.name})`);
  yield* client.disconnect();
});

const fmtWhen = (ms: number) => {
  const date = new Date(ms);
  const now = Date.now();
  const days = Math.floor((now - ms) / 86_400_000);
  if (days <= 0) {
    return date.toLocaleTimeString();
  }
  if (days < 7) {
    return `${days}d ago`;
  }
  return date.toLocaleDateString();
};

/** saku pi list [project] — the added projects' pi sessions on this machine
 *  (CONTEXT.md: Project: the window is project-scoped, never a full scan). */
const cmdPiList = Effect.fn("cmdPiList")(function* (project: string | undefined) {
  const client = yield* connect;
  const sessions = yield* client.listPiSessions(project).pipe(
    Effect.catchIf(
      (error): error is WireError => error instanceof WireError && error.code === "refused",
      () =>
        Effect.fail(
          new WireError({
            code: "refused",
            message: `worker refused the connection (list pi sessions) — it may have just shut down; try: saku daemon status`,
          }),
        ),
    ),
  );
  if (sessions.length === 0) {
    yield* Effect.logInfo(
      project === undefined
        ? "no pi sessions — add a project first: saku project add <path>"
        : `no pi sessions under ${project}`,
    );
    yield* client.disconnect();
    return;
  }
  yield* Effect.logInfo(
    `${pad("ID", 14) + pad("NAME", 28) + pad("MSGS", 7) + pad("MODIFIED", 14)}CWD`,
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

/** saku pi import <id-or-path> — adopt a pi session as a saku thread. A
 *  full `.jsonl` path imports directly (explicit gestures bypass the
 *  window); anything else resolves against the added projects' sessions. */
const cmdPiImport = Effect.fn("cmdPiImport")(function* (arg: string | undefined) {
  if (arg === undefined || arg.length === 0) {
    yield* Effect.fail(
      new CliError({
        code: "usage",
        message: "saku pi import requires a session: saku pi import <id-or-path>",
      }),
    );
    return;
  }
  const client = yield* connect;
  // An explicit path is an explicit gesture: no window lookup needed.
  if (arg.endsWith(".jsonl")) {
    const thread = yield* client.importPiSession(arg).pipe(
      Effect.catchIf(
        (error): error is WireError => error instanceof WireError && error.code === "refused",
        () =>
          Effect.fail(
            new WireError({
              code: "refused",
              message: `worker refused the connection (import pi session) — it may have just shut down; try: saku daemon status`,
            }),
          ),
      ),
    );
    yield* Effect.logInfo(
      `imported ${arg.split("/").pop()} as ${shortThreadId(thread.id)} (${thread.name}) — continue with any saku command`,
    );
    yield* client.disconnect();
    return;
  }
  // Accept a session id, a bare filename, or a full path, scoped to the
  // window (the added projects' sessions).
  const sessions = yield* client.listPiSessions().pipe(
    Effect.catchIf(
      (error): error is WireError => error instanceof WireError && error.code === "refused",
      () =>
        Effect.fail(
          new WireError({
            code: "refused",
            message: `worker refused the connection (list pi sessions) — it may have just shut down; try: saku daemon status`,
          }),
        ),
    ),
  );
  const match =
    sessions.find((session) => session.id === arg) ??
    sessions.find((session) => session.path === arg) ??
    sessions.find((session) => session.path.endsWith(`/${arg}`));
  if (match === undefined) {
    yield* Effect.fail(
      new CliError({
        code: "resolution",
        message: `no pi session matches "${arg}" — try: saku pi list`,
      }),
    );
    return;
  }
  const thread = yield* client.importPiSession(match.path).pipe(
    Effect.catchIf(
      (error): error is WireError => error instanceof WireError && error.code === "refused",
      () =>
        Effect.fail(
          new WireError({
            code: "refused",
            message: `worker refused the connection (import pi session) — it may have just shut down; try: saku daemon status`,
          }),
        ),
    ),
  );
  yield* Effect.logInfo(
    `imported ${match.id.slice(0, 12)} as ${shortThreadId(thread.id)} (${thread.name}) — continue with any saku command`,
  );
  yield* client.disconnect();
});

const cmdPi = Effect.fn("cmdPi")(function* (sub: string | undefined, arg: string | undefined) {
  yield* Match.value(sub).pipe(
    Match.withReturnType<
      Effect.Effect<void, WireError | CliError, Paths | FileSystem.FileSystem>
    >(),
    Match.when("list", () => cmdPiList(arg)),
    Match.when("import", () => cmdPiImport(arg)),
    Match.orElse(() =>
      Effect.fail(new CliError({ code: "usage", message: "saku pi <list|import>" })),
    ),
  );
});

/** saku project add|list|remove — the window's scope (CONTEXT.md: Project). */
const cmdProject = Effect.fn("cmdProject")(function* (
  sub: string | undefined,
  arg: string | undefined,
) {
  yield* Match.value(sub).pipe(
    Match.withReturnType<
      Effect.Effect<void, WireError | CliError, Paths | FileSystem.FileSystem>
    >(),
    Match.when("add", () =>
      Effect.gen(function* () {
        if (arg === undefined || arg.length === 0) {
          yield* Effect.fail(
            new CliError({ code: "usage", message: "saku project add requires a path" }),
          );
          return;
        }
        const client = yield* connect;
        const project = yield* client.addProject(arg).pipe(
          Effect.catchIf(
            (error): error is WireError => error instanceof WireError && error.code === "refused",
            () =>
              Effect.fail(
                new WireError({
                  code: "refused",
                  message: `worker refused the connection (add project) — it may have just shut down; try: saku daemon status`,
                }),
              ),
          ),
        );
        yield* Effect.logInfo(`added ${project.path}`);
        yield* client.disconnect();
      }),
    ),
    Match.when("list", () =>
      Effect.gen(function* () {
        const client = yield* connect;
        const projects = yield* client.listProjects().pipe(
          Effect.catchIf(
            (error): error is WireError => error instanceof WireError && error.code === "refused",
            () =>
              Effect.fail(
                new WireError({
                  code: "refused",
                  message: `worker refused the connection (list projects) — it may have just shut down; try: saku daemon status`,
                }),
              ),
          ),
        );
        if (projects.length === 0) {
          yield* Effect.logInfo("no projects — add one with: saku project add <path>");
        } else {
          for (const project of projects) {
            yield* Effect.logInfo(`${project.path}  (added ${fmtWhen(project.addedAt)})`);
          }
        }
        yield* client.disconnect();
      }),
    ),
    Match.when("remove", () =>
      Effect.gen(function* () {
        if (arg === undefined || arg.length === 0) {
          yield* Effect.fail(
            new CliError({ code: "usage", message: "saku project remove requires a path" }),
          );
          return;
        }
        const client = yield* connect;
        yield* client.removeProject(arg).pipe(
          Effect.catchIf(
            (error): error is WireError => error instanceof WireError && error.code === "refused",
            () =>
              Effect.fail(
                new WireError({
                  code: "refused",
                  message: `worker refused the connection (remove project) — it may have just shut down; try: saku daemon status`,
                }),
              ),
          ),
        );
        yield* Effect.logInfo(`removed ${arg} from the window`);
        yield* client.disconnect();
      }),
    ),
    Match.orElse(() =>
      Effect.fail(new CliError({ code: "usage", message: "saku project <add|list|remove>" })),
    ),
  );
});

/** saku archive|unarchive <thread> — visibility-only (CONTEXT.md: Archive). */
const cmdArchive = Effect.fn("cmdArchive")(function* (
  threadArg: string | undefined,
  unarchive: boolean,
) {
  if (threadArg === undefined) {
    yield* Effect.fail(
      new CliError({
        code: "usage",
        message: `saku ${unarchive ? "unarchive" : "archive"} requires a thread: saku ${unarchive ? "unarchive" : "archive"} <id-or-name>`,
      }),
    );
    return;
  }
  const client = yield* connect;
  const threads = yield* client.listThreads().pipe(
    Effect.catchIf(
      (error): error is WireError => error instanceof WireError && error.code === "refused",
      () =>
        Effect.fail(
          new WireError({
            code: "refused",
            message: `worker refused the connection (list threads) — it may have just shut down; try: saku daemon status`,
          }),
        ),
    ),
  );
  const resolved = resolveThread(threads, threadArg);
  if (Result.isFailure(resolved)) {
    yield* Effect.fail(new CliError({ code: "resolution", message: resolved.failure }));
    return;
  }
  const thread = unarchive
    ? yield* client.unarchiveThread(resolved.success.id).pipe(
        Effect.catchIf(
          (error): error is WireError => error instanceof WireError && error.code === "refused",
          () =>
            Effect.fail(
              new WireError({
                code: "refused",
                message: `worker refused the connection (unarchive thread) — it may have just shut down; try: saku daemon status`,
              }),
            ),
        ),
      )
    : yield* client.archiveThread(resolved.success.id).pipe(
        Effect.catchIf(
          (error): error is WireError => error instanceof WireError && error.code === "refused",
          () =>
            Effect.fail(
              new WireError({
                code: "refused",
                message: `worker refused the connection (archive thread) — it may have just shut down; try: saku daemon status`,
              }),
            ),
        ),
      );
  yield* Effect.logInfo(
    `${unarchive ? "unarchived" : "archived"} ${shortThreadId(thread.id)} (${thread.name}) — the trail is untouched`,
  );
  yield* client.disconnect();
});

const cmdDaemon = Effect.fn("cmdDaemon")(function* (sub: string | undefined) {
  yield* Match.value(sub).pipe(
    Match.withReturnType<Effect.Effect<void, CliError, Paths | FileSystem.FileSystem>>(),
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
    // Fresh-code guarantee: a detached daemon runs the source it was
    // spawned with, so a daemon from an earlier session serves stale
    // code. restart stops whatever answers and boots a new daemon,
    // waiting until it publishes a live socket (the same ensure the
    // on-demand commands use).
    Match.when("restart", () =>
      Effect.gen(function* () {
        const lifecycle = yield* workerLifecycle();
        const stopped = yield* stop(lifecycle);
        yield* Effect.logInfo(
          Option.match(stopped, {
            onNone: () => "not running — starting",
            onSome: (value) => `stopped (pid ${value}) — starting`,
          }),
        );
        const connection = yield* ensure(lifecycle);
        yield* Effect.logInfo(`started (pid ${connection.pid}, ${connection.url})`);
      }),
    ),
    Match.when("status", () =>
      Effect.gen(function* () {
        const lifecycle = yield* workerLifecycle();
        const current = yield* status(lifecycle);
        yield* Effect.logInfo(
          current.running ? `running (pid ${current.pid}, wire ${current.version})` : "not running",
        );
      }),
    ),
    Match.orElse(() =>
      Effect.fail(
        new CliError({ code: "usage", message: "saku daemon <start|stop|restart|status>" }),
      ),
    ),
  );
});

const cmdEnv = Effect.fn("cmdEnv")(function* (sub: string | undefined, hubUrl: string | undefined) {
  yield* Match.value(sub).pipe(
    Match.withReturnType<Effect.Effect<void, CliError, Paths | FileSystem.FileSystem>>(),
    Match.when("start", () =>
      Effect.gen(function* () {
        const config = yield* ensureEnvConfig(hubUrl).pipe(
          Effect.mapError(
            (error) =>
              new CliError({
                cause: error,
                code: "env_config",
                message: `failed to write the env config: ${error instanceof Error ? error.message : String(error)}`,
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
        const relay = config.hubUrl === undefined ? "" : ` (relay to ${config.hubUrl})`;
        yield* Effect.logInfo(`env started (pid ${connection.pid}, ${connection.url})${relay}`);
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
        yield* Effect.logInfo(
          current.running
            ? `running (pid ${current.pid}, protocol ${current.version}, cwd ${current.cwd})`
            : "not running",
        );
      }),
    ),
    Match.orElse(() =>
      Effect.fail(
        new CliError({ code: "usage", message: "saku env <start|stop|status> [--hub <url>]" }),
      ),
    ),
  );
});

const usage = () => `saku — local software factory

usage:
  saku daemon <start|stop|restart|status>
  saku env <start|stop|status> [--hub <url>]
  saku list
  saku new <name> [--cwd <dir>] [--mode local|sandbox|any]
  saku rm <thread>
  saku archive <thread>
  saku unarchive <thread>
  saku project <add|list|remove>
  saku pi list [project]
  saku pi import <id-or-path>
`;

const main = Effect.fn("main")(function* () {
  const args = process.argv.slice(2);
  const [command] = args;
  const rest = args.slice(1);

  const flagValue = (flags: string[], fallback: string) => {
    const index = rest.findIndex((arg) => flags.includes(arg));
    if (index === -1) {
      return fallback;
    }
    return rest[index + 1] ?? fallback;
  };

  yield* Match.value(command).pipe(
    Match.withReturnType<
      Effect.Effect<void, WireError | CliError, Paths | FileSystem.FileSystem>
    >(),
    Match.when("daemon", () => cmdDaemon(rest[0])),
    Match.when("env", () =>
      cmdEnv(rest[0], rest.includes("--hub") ? rest[rest.indexOf("--hub") + 1] : undefined),
    ),
    Match.when("list", () => cmdList()),
    Match.when("new", () => {
      const [name] = rest;
      const cwd = flagValue(["--cwd", "-c"], process.cwd());
      const modeArg = flagValue(["--mode", "-m"], "local");
      const mode: ThreadMode = modeArg === "sandbox" || modeArg === "any" ? modeArg : "local";
      return cmdNew(name, cwd, mode);
    }),
    Match.when("pi", () => cmdPi(rest[0], rest[1])),
    Match.when("project", () => cmdProject(rest[0], rest[1])),
    Match.when("archive", () => cmdArchive(rest[0], false)),
    Match.when("unarchive", () => cmdArchive(rest[0], true)),
    Match.whenOr("rm", "remove", "delete", () => cmdRm(rest[0])),
    Match.whenOr("help", "--help", "-h", () => Effect.logInfo(usage())),
    Match.orElse((unmatched) =>
      Effect.fail(new CliError({ code: "usage", message: `unknown command "${unmatched}"` })),
    ),
  );
});

try {
  await Effect.runPromise(
    Effect.provide([NodeFileSystem.layer, Logger.layer([CliLogger])])(
      Effect.provide(PathsLive)(main()),
    ),
  );
} catch (error) {
  fail(error);
}
