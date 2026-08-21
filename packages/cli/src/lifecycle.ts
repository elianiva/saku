/**
 * Daemon lifecycle (lifecycle.ts): the detached-daemon lifecycle shared by
 * the worker daemon (daemon.ts) and the env daemon (env.ts) — read the
 * published url, probe status over the daemon's protocol, spawn a detached
 * child, wait until it answers, and stop it by SIGTERM.
 *
 * Each daemon configures the lifecycle: its entry point, log/url paths,
 * credential, probe effect, spawn args, and timeout code. The lifecycle
 * owns the storage-layout knowledge (the two files under ~/.saku — the
 * published url and the credential) and the spawn/probe/stop choreography,
 * so a third daemon is a new config, not a new copy of this file.
 */

import { spawn as spawnProcess } from "node:child_process";
import * as NFS from "node:fs/promises";
import path from "node:path";
import { Effect, FileSystem, Option, Schedule } from "effect";

import { CliError } from "./cli-error.ts";

/** The daemon's published identity: the ws url + the credential it enforces. */
export interface DaemonIdentity {
  readonly url: string;
  readonly token: string;
}

/** What the probe learned about a live daemon. */
export interface DaemonInfo {
  readonly pid: number;
  readonly version: string;
  readonly cwd?: string;
}

/** A probed daemon's status; url/token are present when the files exist. */
export interface DaemonStatus {
  readonly running: boolean;
  readonly pid?: number;
  readonly version?: string;
  readonly cwd?: string;
  readonly url?: string;
  readonly token?: string;
}

/** One daemon's configuration of the shared lifecycle. */
export interface DaemonLifecycleConfig {
  /** The daemon's noun in failure messages ("worker" / "env daemon"). */
  readonly label: "worker" | "env daemon";
  /** The resolved entry point the detached child runs. */
  readonly entry: string;
  /** Where the child's stdout/stderr are appended. */
  readonly logPath: string;
  /** Where the daemon publishes its ws url. */
  readonly urlPath: string;
  /** The CliError code when the daemon does not come up after spawning. */
  readonly timeoutCode: "worker_timeout" | "env_timeout";
  /** The credential the daemon enforces; none before first boot. */
  readonly readToken: Effect.Effect<Option.Option<string>, never, FileSystem.FileSystem>;
  /** Probe the daemon over its protocol; none when it does not answer. */
  readonly probe: (identity: DaemonIdentity) => Effect.Effect<Option.Option<DaemonInfo>>;
  /** The child's spawn arguments (after the entry point). */
  readonly args: Effect.Effect<readonly string[], Error, FileSystem.FileSystem>;
}

/** The daemon's published ws url; none when the daemon has never run. */
const readPublishedUrl = Effect.fn(function* (config: DaemonLifecycleConfig) {
  const fs = yield* FileSystem.FileSystem;
  const content = yield* fs
    .readFileString(config.urlPath)
    .pipe(Effect.catch(() => Effect.succeed("")));
  return Option.some(content.trim()).pipe(Option.filter((value) => value.length > 0));
});

/** Probe the daemon over its protocol; never fails, never leaks a socket. */
export const status = Effect.fn("status")(function* (config: DaemonLifecycleConfig) {
  const url = yield* readPublishedUrl(config);
  const token = yield* config.readToken;
  if (Option.isNone(url) || Option.isNone(token)) {
    const result: DaemonStatus = { running: false };
    return result;
  }
  const identity: DaemonIdentity = { token: token.value, url: url.value };
  const info = yield* config.probe(identity);
  const result: DaemonStatus = Option.match(info, {
    onNone: () => ({ ...identity, running: false }),
    onSome: (value) => ({ ...identity, ...value, running: true }),
  });
  return result;
});

/** Build a spawn-failure CliError for `label`. */
const spawnFailed = (label: DaemonLifecycleConfig["label"], cause: unknown) =>
  new CliError({
    cause,
    code: "spawn_failed",
    message: `failed to spawn the ${label}: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

/**
 * Spawn a detached daemon; returns its pid. A failed spawn is never a
 * return value — the child emits its 'error' event asynchronously, so it
 * is funneled into the error channel instead of reporting a phantom
 * "started (pid 0)".
 */
export const spawn = Effect.fn("spawn")(function* (config: DaemonLifecycleConfig) {
  const fs = yield* FileSystem.FileSystem;
  const { label } = config;
  // A fresh home has no ~/.saku yet; the log fd needs the directory.
  yield* fs
    .makeDirectory(path.dirname(config.logPath), { mode: 0o700, recursive: true })
    .pipe(Effect.mapError((cause) => spawnFailed(label, cause)));
  // NFS.open is needed here because spawnProcess requires a raw file descriptor
  // number for stdio, and Effect's File interface doesn't expose it.
  const logFd = yield* Effect.tryPromise(() => NFS.open(config.logPath, "a")).pipe(
    Effect.mapError((cause) => spawnFailed(label, cause)),
  );
  const args = yield* config.args.pipe(Effect.mapError((cause) => spawnFailed(label, cause)));
  const child = spawnProcess(process.execPath, [config.entry, ...args], {
    detached: true,
    stdio: ["ignore", logFd.fd, logFd.fd],
  });
  // The pid is set synchronously on a successful spawn, so the promise
  // resolves without waiting; a failed spawn leaves it undefined and the
  // child emits 'error' instead, which rejects the promise.
  const pid = yield* Effect.tryPromise(
    () =>
      new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        if (child.pid !== undefined) {
          resolve(child.pid);
        }
      }),
  ).pipe(Effect.mapError((cause) => spawnFailed(label, cause)));
  // The child holds the inherited fd; drop the parent's handle.
  yield* Effect.tryPromise(() => logFd.close()).pipe(
    Effect.mapError((cause) => spawnFailed(label, cause)),
  );
  child.unref();
  return pid;
});

/**
 * The daemon answered the probe with the pid/url/token a console needs to
 * attach; the predicate `ensure`'s fast path and `waitForUp`'s poll share.
 */
const isConnected = (
  current: DaemonStatus,
): current is DaemonStatus & { pid: number; url: string; token: string } =>
  current.running &&
  current.pid !== undefined &&
  current.url !== undefined &&
  current.token !== undefined;

/**
 * Probe until `predicate` holds: the first probe plus `retries` more,
 * 100 ms apart, then fail with `${label} ${what}`.
 */
const poll = (
  config: DaemonLifecycleConfig,
  predicate: (current: DaemonStatus) => boolean,
  retries: number,
  what: string,
) =>
  status(config).pipe(
    Effect.filterOrFail(predicate, () => new Error(`${config.label} ${what}`)),
    Effect.retry({ schedule: Schedule.spaced("100 millis"), times: retries }),
  );

/** Probe until the daemon answers: first probe + 99 retries, 100 ms apart. */
const waitForUp = (config: DaemonLifecycleConfig) =>
  poll(config, isConnected, 99, "did not answer");

/** Probe until the daemon is gone: first probe + 49 retries, 100 ms apart. */
const waitForStop = (config: DaemonLifecycleConfig) =>
  // 50 probes exhausted: give up silently, like the old loop's break.
  poll(config, (current) => !current.running, 49, "did not stop").pipe(Effect.ignore);

/** Spawn if needed and wait until the socket answers. Returns the connection info. */
export const ensure = Effect.fn("ensure")(function* (config: DaemonLifecycleConfig) {
  const current = yield* status(config);
  if (isConnected(current)) {
    return { pid: current.pid, token: current.token, url: current.url };
  }
  const pid = yield* spawn(config);
  const now = yield* waitForUp(config).pipe(
    Effect.mapError(
      () =>
        new CliError({
          code: config.timeoutCode,
          message: `${config.label === "worker" ? "daemon" : "env daemon"} did not come up (spawned pid ${pid}); see ${config.logPath}`,
        }),
    ),
  );
  // The poll predicate proved the probe answered; narrow the connection
  // info explicitly (the predicate rides a plain boolean, so the type needs
  // one guard here).
  if (!isConnected(now)) {
    return yield* Effect.fail(
      new CliError({
        code: config.timeoutCode,
        message: `${config.label === "worker" ? "daemon" : "env daemon"} came up without connection info`,
      }),
    );
  }
  return { pid: now.pid, token: now.token, url: now.url };
});

/** Stop the daemon; returns the pid that was stopped, or none. */
export const stop = Effect.fn("stop")(function* (config: DaemonLifecycleConfig) {
  const current = yield* status(config);
  if (!current.running || current.pid === undefined) {
    return Option.none();
  }
  const { pid } = current;
  // Already gone is fine — the process was reaped between the probe and now.
  yield* Effect.try(() => process.kill(pid, "SIGTERM")).pipe(Effect.catch(() => Effect.void));
  yield* waitForStop(config);
  return Option.some(pid);
});
