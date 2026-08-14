/**
 * The env daemon entry (entry.ts): the process the CLI spawns (`saku env
 * start`) and the Box's systemd service runs.
 *
 * Flags: `--token <env token>`, `--cwd <workspace>`, `--hub <hub url>`
 * + `--env-id <id>` + `--hub-token <deployment secret>` for relay
 * registration (the local machine's outbound path; a Box daemon runs
 * without `--hub` — the worker reaches it through the `host --private`
 * URL directly). The daemon publishes its URL to `~/.saku/env.url` and
 * logs to stdout (the CLI redirects it to `~/.saku/env.log`).
 *
 * The program is a scoped resource: the daemon (and the relay client,
 * when configured) are acquired and the process idles on `Effect.never`;
 * `NodeRuntime.runMain` interrupts on SIGINT/SIGTERM and the finalizers
 * close the sockets before exit.
 */

import { dirname } from "node:path";
import { runMain } from "@effect/platform-node/NodeRuntime";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, FileSystem } from "effect";

import { getEnvUrlPath } from "./paths.ts";
import { makeEnvDaemon } from "./daemon.ts";
import { makeEnvRelayClient } from "./relay.ts";

/** Minimal flag parsing: `--name value` pairs; no deps, no surprises. */
const flags = (args: readonly string[]) => {
  const map = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === undefined || value === undefined) continue;
    if (!flag.startsWith("--")) continue;
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
  const log = (message: string) =>
    Effect.logInfo(`[saku-env] ${message}`);

  const daemon = yield* makeEnvDaemon({
    token,
    cwd,
    fs,
    log,
    ...(Number.isInteger(port) && port > 0 ? { port } : {}),
  });
  yield* log(`listening on ${daemon.url}`);
  // The CLI reads the URL from ~/.saku/env.url; create the dir first.
  yield* fs
    .makeDirectory(dirname(getEnvUrlPath()), { recursive: true })
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
      yield* makeEnvRelayClient({
        url: hub,
        envId,
        token: hubToken,
        hello: { token, version: "1", cwd },
        fs,
        log,
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
