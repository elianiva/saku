/**
 * saku/worker — the local worker daemon: registry + per-thread session hosts
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
export { DaemonError } from "./daemon-error.ts";
export { RegistryError } from "./registry-error.ts";
export { DoSessionStorage, type DoSessionMetadata } from "./do-session.ts";
export { DoSessionRepo } from "./do-session-repo.ts";
export {
  ModelCatalog,
  ModelCatalogLive,
  ModelCatalogTest,
  type CatalogOptions,
  type ModelCatalogApi,
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
  type HostRegistryApi,
  type ThreadRecord,
  type ThreadRegistryApi,
} from "./registry.ts";
export { listProjects, addProject, removeProject, type ProjectRecord } from "./projects.ts";
export {
  SakuDaemon,
  SakuDaemonLive,
  SakuDaemonTest,
  SakuDaemonLayer,
  type DaemonOptions,
  type SakuDaemonApi,
} from "./daemon.ts";
export { Paths, PathsLive, PathsTest, type PathsLayout } from "./paths.ts";
