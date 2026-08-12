/**
 * Daemon stewardship (daemon.ts): spawn, probe, and stop the worker.
 *
 * The daemon is a detached `node` child running `@saku/worker/daemon`, its
 * stdout/stderr appended to `~/.saku/worker.log`. The daemon publishes its
 * WebSocket URL to `~/.saku/worker.url`; status is probed over the wire
 * (hello_ok carries the pid); stopping sends SIGTERM to that pid.
 */

import { spawn } from "node:child_process";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Option } from "effect";

import { makeWireClient } from "@saku/wire";
import { getAuthPath, getWorkerLogPath, getWorkerUrlPath } from "@saku/worker";

export const resolveDaemonEntry = (): string => fileURLToPath(import.meta.resolve("@saku/worker/daemon"));

export interface DaemonStatus {
  readonly running: boolean;
  readonly pid?: number;
  readonly version?: string;
}

/** The daemon's published ws URL; none when the daemon has never run. */
export const readWorkerUrl = (): Effect.Effect<Option.Option<string>, never, never> =>
  Effect.tryPromise(() => readFile(getWorkerUrlPath(), "utf8")).pipe(
    Effect.map((content) => Option.some(content.trim()).pipe(Option.filter((value) => value.length > 0))),
    Effect.catch(() => Effect.succeed(Option.none())),
  );

/** The auth token the daemon enforces; none before first boot. */
export const readWorkerToken = (): Effect.Effect<Option.Option<string>, never, never> =>
  Effect.tryPromise(() => readFile(getAuthPath(), "utf8")).pipe(
    Effect.map((content) => Option.some(content.trim()).pipe(Option.filter((value) => value.length > 0))),
    Effect.catch(() => Effect.succeed(Option.none())),
  );

/** Probe the daemon over the wire; never fails, never leaks a socket. */
export const daemonStatus = (): Effect.Effect<DaemonStatus, never, never> =>
  Effect.gen(function* () {
    const url = yield* readWorkerUrl();
    const token = yield* readWorkerToken();
    if (Option.isNone(url) || Option.isNone(token)) return { running: false };
    const client = yield* makeWireClient({ url: url.value, token: token.value, role: "cli" });
    const hello = yield* client.connect().pipe(
      Effect.timeout("2 seconds"),
      Effect.map(Option.some),
      Effect.catch(() => Effect.succeed(Option.none())),
    );
    yield* client.disconnect();
    return Option.match(hello, {
      onNone: () => ({ running: false }),
      onSome: (value) => ({ running: true, pid: value.pid, version: value.version }),
    });
  });

/** Spawn a detached daemon; returns its pid (0 when spawn failed). */
export const spawnDaemon = (): Effect.Effect<number, Error, never> =>
  Effect.gen(function* () {
    // A fresh home has no ~/.saku yet; the log fd needs the directory.
    yield* Effect.tryPromise(() => mkdir(dirname(getWorkerLogPath()), { recursive: true, mode: 0o700 }));
    const logFd = yield* Effect.tryPromise(() => open(getWorkerLogPath(), "a"));
    const child = spawn(process.execPath, [resolveDaemonEntry()], {
      detached: true,
      stdio: ["ignore", logFd.fd, logFd.fd],
    });
    // The child holds the inherited fd; drop the parent's handle.
    yield* Effect.tryPromise(() => logFd.close());
    child.unref();
    return child.pid ?? 0;
  });

/** Spawn if needed and wait until the socket answers. Returns the pid. */
export const ensureDaemon = (): Effect.Effect<number, Error, never> =>
  Effect.gen(function* () {
    const status = yield* daemonStatus();
    if (status.running && status.pid !== undefined) return status.pid;
    const pid = yield* spawnDaemon();
    for (let i = 0; i < 100; i++) {
      yield* Effect.sleep("100 millis");
      const now = yield* daemonStatus();
      if (now.running && now.pid !== undefined) return now.pid;
    }
    return yield* Effect.fail(new Error(`daemon did not come up (spawned pid ${pid}); see ${getWorkerLogPath()}`));
  });

/** Stop the daemon; returns the pid that was stopped, or none. */
export const stopDaemon = (): Effect.Effect<Option.Option<number>, never, never> =>
  Effect.gen(function* () {
    const status = yield* daemonStatus();
    if (!status.running || status.pid === undefined) return Option.none();
    const pid = status.pid;
    // Already gone is fine — the process was reaped between the probe and now.
    yield* Effect.try(() => process.kill(pid, "SIGTERM")).pipe(Effect.catch(() => Effect.void));
    for (let i = 0; i < 50; i++) {
      yield* Effect.sleep("100 millis");
      const now = yield* daemonStatus();
      if (!now.running) break;
    }
    return Option.some(status.pid);
  });
