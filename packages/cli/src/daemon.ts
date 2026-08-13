/**
 * Worker daemon stewardship (daemon.ts): the worker daemon's
 * configuration of the shared daemon lifecycle (lifecycle.ts) — spawn,
 * probe, and stop the worker.
 *
 * The daemon is a detached `node` child running `@saku/worker/daemon`, its
 * stdout/stderr appended to `~/.saku/worker.log`. The daemon publishes its
 * WebSocket URL to `~/.saku/worker.url`; status is probed over the wire
 * (hello_ok carries the pid); stopping sends SIGTERM to that pid. The
 * credential is `~/.saku/auth` (the deployment secret the daemon enforces).
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Effect, Option } from "effect";

import { makeWireClient } from "@saku/wire";
import { getAuthPath, getWorkerLogPath, getWorkerUrlPath } from "@saku/worker";

import { type DaemonLifecycleConfig } from "./lifecycle.ts";

export const resolveDaemonEntry = (): string =>
  fileURLToPath(import.meta.resolve("@saku/worker/daemon"));

/** The worker daemon's lifecycle: wire-hello probe, no spawn args. */
export const workerLifecycle: DaemonLifecycleConfig = {
  label: "worker",
  entry: resolveDaemonEntry(),
  logPath: getWorkerLogPath(),
  urlPath: getWorkerUrlPath(),
  timeoutCode: "worker_timeout",
  readToken: Effect.tryPromise(() => readFile(getAuthPath(), "utf8")).pipe(
    Effect.map((content) =>
      Option.some(content.trim()).pipe(Option.filter((value) => value.length > 0)),
    ),
    Effect.catch(() => Effect.succeed(Option.none())),
  ),
  probe: (identity) =>
    Effect.gen(function* () {
      const client = yield* makeWireClient({
        url: identity.url,
        token: identity.token,
        role: "cli",
      });
      const hello = yield* client.connect().pipe(
        Effect.timeout("2 seconds"),
        Effect.map(Option.some),
        Effect.catch(() => Effect.succeed(Option.none())),
      );
      yield* client.disconnect();
      return Option.match(hello, {
        onNone: () => Option.none(),
        onSome: (value) => Option.some({ pid: value.pid, version: value.version }),
      });
    }),
  args: Effect.succeed([]),
};
