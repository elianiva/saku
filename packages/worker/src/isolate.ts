/**
 * The worker's isolate entry (isolate.ts): the per-thread worker surface
 * that runs inside a Durable Object (Cloudflare or celld) — everything the
 * thread DO needs and nothing that binds to node.
 *
 * The module graph here is workerd-clean: `SessionHost` + `DoSessionRepo`
 * over the `KvStore` seam, `buildTools`, the host/registry types, the
 * registry record schema, and the shared catalog construction. The
 * node-bound wiring (file trails, `LocalEnv`, the model catalog over
 * auth.json, the daemon itself) lives in the package's main entry; a DO
 * passes its own storage (`KvStore` over DO storage) and its own env
 * (`RemoteEnv`), and builds a catalog from deployment secrets.
 */

export { DoSessionStorage, type DoSessionMetadata } from "./do-session.ts";
export { DoSessionRepo } from "./do-session-repo.ts";
export { buildTools } from "./tools.ts";
export {
  SessionHost,
  SessionHostError,
  type HostEventSink,
  type HostState,
  type SessionHostOptions,
} from "./session-host.ts";
export { runSessionCommand, type SessionCommandDeps } from "./session-commands.ts";
export {
  createModelCatalog,
  type ModelCatalogAuthSource,
  type ModelCatalogApi,
} from "./model-catalog-factory.ts";
export { ThreadRecordSchema, type ThreadRecord } from "./registry-record.ts";
export type { HostRegistryApi, ThreadRegistryApi } from "./registry.ts";
