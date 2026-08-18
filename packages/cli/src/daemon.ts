import { fileURLToPath } from "node:url";
import { Effect, FileSystem, Option } from "effect";

import { WireClient } from "@saku/wire";
import { Paths } from "@saku/worker";

/**
 * The worker daemon's lifecycle config, resolved against the layout when
 * the command runs (the CLI's root provides `PathsLive`, so `SAKU_HOME` is
 * read once per command, not at module load).
 */
export const workerLifecycle = Effect.fn("workerLifecycle")(function* () {
  const paths = yield* Paths;
  const fs = yield* FileSystem.FileSystem;

  return {
    args: Effect.succeed([]),
    entry: fileURLToPath(import.meta.resolve("@saku/worker/daemon")),
    label: "worker" as const,
    logPath: paths.workerLogPath,
    probe: Effect.fn("probe")(function* (identity) {
      const client = yield* WireClient.make({
        role: "cli",
        token: identity.token,
        url: identity.url,
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
    readToken: fs.readFileString(paths.authPath).pipe(
      Effect.map((content) =>
        Option.some(content.trim()).pipe(Option.filter((value) => value.length > 0)),
      ),
      Effect.catch(() => Effect.succeed(Option.none())),
    ),
    timeoutCode: "worker_timeout" as const,
    urlPath: paths.workerUrlPath,
  };
});
