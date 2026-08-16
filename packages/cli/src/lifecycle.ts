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
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { Effect, Option, Schedule } from "effect";

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

/** A live daemon's connection info: what a console needs to attach. */
export interface DaemonConnection {
  readonly pid: number;
  readonly url: string;
  readonly token: string;
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
  readonly readToken: Effect.Effect<Option.Option<string>>;
  /** Probe the daemon over its protocol; none when it does not answer. */
  readonly probe: (identity: DaemonIdentity) => Effect.Effect<Option.Option<DaemonInfo>>;
  /** The child's spawn arguments (after the entry point). */
  readonly args: Effect.Effect<readonly string[], Error>;
}

/** The daemon's published ws url; none when the daemon has never run. */
export const readPublishedUrl = (config: DaemonLifecycleConfig) =>
  Effect.tryPromise(async () => await readFile(config.urlPath, "utf-8")).pipe(
    Effect.map((content) =>
      Option.some(content.trim()).pipe(Option.filter((value) => value.length > 0)),
    ),
    Effect.orElseSucceed(() => Option.none()),
  );

/** Probe the daemon over its protocol; never fails, never leaks a socket. */
export const status = Effect.fn("status")(function* status(
  config: DaemonLifecycleConfig,
): Effect.fn.Return<DaemonStatus> {
  const url = yield* readPublishedUrl(config);
  const token = yield* config.readToken;
  if (Option.isNone(url) || Option.isNone(token)) {
    return { running: false };
  }
  const identity: DaemonIdentity = { token: token.value, url: url.value };
  const info = yield* config.probe(identity);
  return Option.match(info, {
    onNone: () => ({ running: false, ...identity }),
    onSome: (value) => {
      const base = {
        running: true,
        ...identity,
        pid: value.pid,
        version: value.version,
      };
      return value.cwd === undefined ? base : { ...base, cwd: value.cwd };
    },
  });
});

const spawnFailure = (label: DaemonLifecycleConfig["label"]) => (cause: unknown) =>
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
export const spawn = Effect.fn("spawn")(function* spawn(config: DaemonLifecycleConfig) {
  // A fresh home has no ~/.saku yet; the log fd needs the directory.
  yield* Effect.tryPromise(
    async () => await mkdir(path.dirname(config.logPath), { mode: 0o700, recursive: true }),
  ).pipe(Effect.mapError(spawnFailure(config.label)));
  const logFd = yield* Effect.tryPromise(async () => await open(config.logPath, "a")).pipe(
    Effect.mapError(spawnFailure(config.label)),
  );
  const args = yield* config.args.pipe(Effect.mapError(spawnFailure(config.label)));
  const child = spawnProcess(process.execPath, [config.entry, ...args], {
    detached: true,
    stdio: ["ignore", logFd.fd, logFd.fd],
  });
  // pid is set synchronously on a successful spawn; on failure it stays
  // undefined and the 'error' event carries the cause.
  const pid = yield* Effect.tryPromise(async () => {
    const { promise, resolve, reject } = Promise.withResolvers<number>();
    child.once("error", reject);
    if (child.pid !== undefined) {
      resolve(child.pid);
    }
    return await promise;
  }).pipe(Effect.mapError(spawnFailure(config.label)));
  // The child holds the inherited fd; drop the parent's handle.
  yield* Effect.tryPromise(async () => {
    await logFd.close();
  }).pipe(Effect.mapError(spawnFailure(config.label)));
  child.unref();
  return pid;
});

/**
 * Probe until the daemon answers: first probe + 99 retries, 100 ms apart.
 * The error channel is the retry-exhausted probe failure (`undefined`).
 */
export const waitForUp = (config: DaemonLifecycleConfig) =>
  status(config).pipe(
    Effect.filterOrFail(
      (current): current is DaemonStatus & { pid: number; url: string; token: string } =>
        current.running &&
        current.pid !== undefined &&
        current.url !== undefined &&
        current.token !== undefined,
      () => {
        // the retry-exhausted probe failure is void
      },
    ),
    Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 99 }),
  );

/** Spawn if needed and wait until the socket answers. Returns the connection info. */
export const ensure = Effect.fn("ensure")(function* ensure(config: DaemonLifecycleConfig) {
  const current = yield* status(config);
  if (
    current.running &&
    current.pid !== undefined &&
    current.url !== undefined &&
    current.token !== undefined
  ) {
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
  return { pid: now.pid, token: now.token, url: now.url };
});

/** Probe until the daemon is gone: first probe + 49 retries, 100 ms apart. */
export const waitForStop = (config: DaemonLifecycleConfig) =>
  status(config).pipe(
    Effect.filterOrFail(
      (current) => !current.running,
      () => {
        // the retry-exhausted probe failure is void
      },
    ),
    Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 49 }),
    // 50 probes exhausted: give up silently, like the old loop's break.
    Effect.ignore,
  );

/** Stop the daemon; returns the pid that was stopped, or none. */
export const stop = Effect.fn("stop")(function* stop(config: DaemonLifecycleConfig) {
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
