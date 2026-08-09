/**
 * @saku/worker — the local worker daemon: registry + per-thread session hosts
 * over the saku wire protocol.
 *
 * The daemon is the server-side home of pi sessions: each thread gets a
 * `SessionHost` (Agent + Session + compaction) that appends durable entries,
 * projects agent events onto the wire, and recovers after crashes/restarts.
 */

export { ensureAuthToken, readAuthToken, ensureSakuDirs } from "./auth.ts";
export { LocalEnv } from "./local-env.ts";
export { ModelCatalog, type CatalogOptions } from "./model-catalog.ts";
export { buildTools } from "./tools.ts";
export { SessionHost, SessionHostError } from "./session-host.ts";
export { ThreadRegistry, type ThreadRecord } from "./registry.ts";
export { SakuDaemon, type DaemonOptions } from "./daemon.ts";
export * from "./paths.ts";
