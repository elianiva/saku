import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Effect, Option } from "effect";

import { WireClient } from "@saku/wire";
import { Paths } from "@saku/worker";

import { type DaemonLifecycleConfig } from "./lifecycle.ts";

/**
 * The worker daemon's lifecycle config, resolved against the layout when
 * the command runs (the CLI's root provides `PathsLive`, so `SAKU_HOME` is
 * read once per command, not at module load).
 */
export const workerLifecycle = Effect.fn("workerLifecycle")(function* (): Effect.fn.Return<
  DaemonLifecycleConfig,
  never,
  Paths
> {
  const paths = yield* Paths;
  return {
    label: "worker",
    entry: fileURLToPath(import.meta.resolve("@saku/worker/daemon")),
    logPath: paths.workerLogPath,
    urlPath: paths.workerUrlPath,
    timeoutCode: "worker_timeout",
    readToken: Effect.tryPromise(() => readFile(paths.authPath, "utf8")).pipe(
      Effect.map((content) =>
        Option.some(content.trim()).pipe(Option.filter((value) => value.length > 0)),
      ),
      Effect.catch(() => Effect.succeed(Option.none())),
    ),
    probe: Effect.fn("probe")(function* (identity) {
      const client = yield* WireClient.make({
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
});
