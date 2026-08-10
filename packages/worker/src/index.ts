/**
 * @saku/worker — the local worker daemon: registry + per-thread session hosts
 * over the saku wire protocol.
 *
 * The daemon is the server-side home of pi sessions: each thread gets a
 * `SessionHost` (Agent + Session + compaction) that appends durable entries,
 * projects agent events onto the wire, and recovers after crashes/restarts.
 *
 * `SakuDaemonLayer` is the runnable resource (registry + catalog + socket
 * server); the daemon-entry process provides it under `Effect.never`.
 */

export { ensureAuthToken, readAuthToken, ensureSakuDirs } from "./auth.ts";
export { isNotFound } from "./fs.ts";
export { LocalEnv } from "./local-env.ts";
export { ModelCatalog, ModelCatalogLive, type CatalogOptions, type ModelCatalogShape } from "./model-catalog.ts";
export { buildTools } from "./tools.ts";
export { SessionHost, SessionHostError } from "./session-host.ts";
export {
  ThreadRegistry,
  ThreadRegistryLive,
  RegistryError,
  type ThreadRecord,
  type ThreadRegistryShape,
} from "./registry.ts";
export {
  SakuDaemon,
  SakuDaemonLive,
  SakuDaemonLayer,
  DaemonError,
  type DaemonOptions,
  type SakuDaemonShape,
} from "./daemon.ts";
export * from "./paths.ts";
