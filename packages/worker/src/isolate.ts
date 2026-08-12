/**
 * The worker's isolate entry (isolate.ts): the per-thread worker surface
 * that runs inside a Durable Object (Cloudflare or celld) — everything the
 * thread DO needs and nothing that binds to node.
 *
 * The module graph here is workerd-clean: `SessionHost` + `DoSessionRepo`
 * over the `KvStore` seam, `buildTools`, and the host/registry types. The
 * node-bound wiring (file trails, `LocalEnv`, the model catalog over
 * auth.json, the daemon itself) lives in the package's main entry; a DO
 * passes its own storage (`KvStore` over DO storage) and its own env
 * (`RemoteEnv`), and builds a catalog from deployment secrets.
 */

export { DoSessionRepo, DoSessionStorage, type DoSessionMetadata } from "./do-session.ts";
export { buildTools } from "./tools.ts";
export { RegistryError } from "./registry-error.ts";
export {
  SessionHost,
  SessionHostError,
  type HostEventSink,
  type HostState,
  type SessionHostOptions,
} from "./session-host.ts";
export type { ThreadRecord, ThreadRegistryShape } from "./registry.ts";
export type { ModelCatalogShape } from "./model-catalog.ts";
