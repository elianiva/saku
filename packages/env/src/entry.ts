/**
 * The env daemon entry (entry.ts): the process the CLI spawns (`saku env
 * start`) and a remote-machine supervisor runs.
 *
 * Flags: `--token <env token>`, `--cwd <workspace>`, `--hub <hub url>`
 * + `--env-id <id>` + `--hub-token <deployment secret>` for relay
 * registration (the local machine's outbound path; a remote-machine daemon
 * may run without `--hub` when its provider exposes a direct endpoint). The
 * daemon publishes its URL to `~/.saku/env.url` and
 * logs to stdout (the CLI redirects it to `~/.saku/env.log`).
 *
 * The program is a scoped resource: the daemon (and the relay client,
 * when configured) are acquired and the process idles on `Effect.never`;
 * `NodeRuntime.runMain` interrupts on SIGINT/SIGTERM and the finalizers
 * close the sockets before exit.
 */

import path from "node:path";
import { runMain } from "@effect/platform-node/NodeRuntime";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, FileSystem } from "effect";

import { getEnvUrlPath } from "./paths.ts";
import { EnvDaemon } from "./daemon.ts";
import type { EnvDaemonOptions } from "./daemon.ts";
import { EnvRelayClient } from "./relay.ts";

/** The daemon's log line; the CLI captures stdout into ~/.saku/env.log. */
const log = (message: string) => Effect.logInfo(`[saku-env] ${message}`);

/** Minimal flag parsing: `--name value` pairs; no deps, no surprises. */
const flags = (args: readonly string[]) => {
  const map = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === undefined || value === undefined) {
      continue;
    }
    if (!flag.startsWith("--")) {
      continue;
    }
    map.set(flag, value);
  }
  return map;
};

const program = Effect.gen(function* () {
  const args = flags(process.argv.slice(2));
  const token = args.get("--token") ?? "";
  const cwd = args.get("--cwd") ?? process.cwd();
  const port = Number(args.get("--port") ?? "0");
  const fs = yield* FileSystem.FileSystem;

  let daemonOptions: EnvDaemonOptions = { cwd, fs, log, token };
  if (Number.isInteger(port) && port > 0) {
    daemonOptions = { ...daemonOptions, port };
  }
  const daemon = yield* EnvDaemon.make(daemonOptions);
  yield* log(`listening on ${daemon.url}`);
  // The CLI reads the URL from ~/.saku/env.url; create the dir first.
  yield* fs
    .makeDirectory(path.dirname(getEnvUrlPath()), { recursive: true })
    .pipe(Effect.catch(() => Effect.void));
  yield* fs
    .writeFileString(getEnvUrlPath(), `${daemon.url}\n`)
    .pipe(Effect.catch(() => Effect.void));
  yield* Effect.addFinalizer(() =>
    fs.remove(getEnvUrlPath(), { force: true }).pipe(
      Effect.catch(() => Effect.void),
      Effect.andThen(daemon.close()),
    ),
  );

  const hub = args.get("--hub");
  if (hub !== undefined) {
    const envId = args.get("--env-id");
    const hubToken = args.get("--hub-token");
    if (envId === undefined || hubToken === undefined) {
      yield* log("--hub requires --env-id and --hub-token; skipping relay registration");
    } else {
      yield* EnvRelayClient.make({
        envId,
        fs,
        hello: { cwd, token, version: "1" },
        log,
        token: hubToken,
        url: hub,
      });
      yield* log(`relay client started for ${envId.slice(0, 8)} (${hub})`);
    }
  }
});

const main = Effect.gen(function* () {
  yield* program;
  return yield* Effect.never;
});

// The daemon and the relay client are scoped resources: acquire them in a
// scope, idle forever, and let the scope's finalizers close the sockets.
runMain(Effect.provide(NodeFileSystem.layer)(Effect.scoped(main)));
