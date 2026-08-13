/**
 * @saku/hub — the control plane of the managed-agents spine (ADR 0001):
 * the durable thread registry, the worker seam (per-thread workers), the
 * env provisioner seam, the hub-hosted skills store, and the wire server
 * (WebSocket JSONL, hello/version auth, stateless routing, fan-out).
 *
 * The core (`makeHub`) is transport-free — the wire server adapts it to
 * WebSocket frames, and the alchemy DO adapter (M4) will adapt it to the
 * deployment entry point. Everything durable lives on the `KvStore` seam
 * (`@saku/store`), so the same code runs inside a Durable Object and
 * in-process.
 */

export { HubError, messageOf } from "./hub-error.ts";
export {
  makeIdleStop,
  type IdleStop,
  type IdleStopController,
  type IdleStopDeps,
} from "./idle-stop.ts";
export { makeHubRegistry, type HubRecord, type HubRegistryShape } from "./registry.ts";
export { makeSkillsStore, skillNameFromSource, type SkillsStoreShape } from "./skills.ts";
export {
  makeProvisioner,
  boxSystemdUnit,
  boxRunScript,
  boxEnsureNodeCommand,
  boxInstallCommand,
  BOX_DAEMON_PORT,
  BOX_ENV_DIR,
  BOX_NODE_VERSION,
  type EnvProvisioner,
  type ProvisionerDeps,
} from "./provisioner.ts";
export {
  makeBoxApi,
  pollUntilReady,
  BoxError,
  type BoxApi,
  type BoxInfo,
  type BoxApiDeps,
  type CommandResult,
} from "./box.ts";
export { makeHubRelay, type HubRelayShape, type RelayServerOptions } from "./relay.ts";
export { makeHubRelayCore, type HubRelayCoreShape } from "./relay-core.ts";
export { makeWireCore, type WireCoreOptions, type WireCoreShape } from "./wire-core.ts";
export { workerdSocket, type SocketLike, type WorkerdWebSocketLike } from "./socket.ts";
export {
  type HubEventSink,
  type ThreadWorkerRef,
  type WorkerCommandResult,
  type WorkerReport,
} from "./worker-ref.ts";
export {
  makeHub,
  type HubDeps,
  type HubEvent,
  type HubListener,
  type HubShape,
} from "./hub.ts";
export { makeHubServer, type HubServerOptions, type HubServerShape } from "./server.ts";
