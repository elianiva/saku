/**
 * Daemon entry (daemon-entry.ts): the process the CLI spawns.
 *
 * `saku daemon start` spawns `node daemon-entry.ts` detached with its output
 * redirected to `~/.saku/worker.log`; this module owns the process lifetime.
 *
 * The daemon runs as a scoped resource: `SakuDaemonLayer` acquires the
 * registry, catalog, and socket server; the program idles on `Effect.never`
 * until `NodeRuntime.runMain` interrupts the fiber on SIGINT/SIGTERM, which
 * runs the layer's finalizers (hosts disposed, clients dropped, socket
 * unlinked) before the process exits.
 */

import { runMain } from "@effect/platform-node/NodeRuntime";
import { Effect } from "effect";

import { SakuDaemon, SakuDaemonLayer } from "./daemon.ts";

const program: Effect.Effect<never, Error, SakuDaemon> = Effect.gen(function* () {
  yield* SakuDaemon;
  return yield* Effect.never;
});

runMain(Effect.provide(SakuDaemonLayer)(program));
