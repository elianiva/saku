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
export { RegistryError } from "./registry-error.ts";
export { DoSessionRepo, DoSessionStorage, type DoSessionMetadata } from "./do-session.ts";
export {
  ModelCatalog,
  ModelCatalogLive,
  ModelCatalogTest,
  type CatalogOptions,
  type ModelCatalogShape,
} from "./model-catalog.ts";
export { buildTools } from "./tools.ts";
export {
  SessionHost,
  SessionHostError,
  type HostEventSink,
  type HostState,
  type SessionHostOptions,
} from "./session-host.ts";
export {
  ThreadRegistry,
  ThreadRegistryLive,
  ThreadRegistryTest,
  ThreadRecordSchema,
  type HostRegistryShape,
  type ThreadRecord,
  type ThreadRegistryShape,
} from "./registry.ts";
export { listProjects, addProject, removeProject, type ProjectRecord } from "./projects.ts";
export {
  SakuDaemon,
  SakuDaemonLive,
  SakuDaemonTest,
  SakuDaemonLayer,
  DaemonError,
  type DaemonOptions,
  type SakuDaemonShape,
} from "./daemon.ts";
export * from "./paths.ts";
