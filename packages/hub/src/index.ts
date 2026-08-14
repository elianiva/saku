/**
 * @saku/hub — the control plane of the managed-agents spine (ADR 0001):
 * the durable thread registry, the worker seam (per-thread workers), the
 * env provisioner seam, the hub-hosted skills store, and the wire server
 * (WebSocket JSONL, hello/version auth, stateless routing, fan-out).
 *
 * The core (`Hub.make`) is transport-free — the wire server adapts it to
 * WebSocket frames, and the alchemy DO adapter (M4) will adapt it to the
 * deployment entry point. Everything durable lives on the `KvStore` seam
 * (`@saku/store`), so the same code runs inside a Durable Object and
 * in-process.
 */

export { HubError, messageOf } from "./hub-error.ts";
export {
  IdleStop,
  type IdleStopShape,
  type IdleStopController,
  type IdleStopDeps,
} from "./idle-stop.ts";
export { HubRegistry, type HubRecord, type HubRegistryShape } from "./registry.ts";
export { SkillsStore, skillNameFromSource, type SkillsStoreShape } from "./skills.ts";
export {
  Provisioner,
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
  BoxApi,
  pollUntilReady,
  BoxError,
  type BoxApiShape,
  type BoxInfo,
  type BoxApiDeps,
  type CommandResult,
} from "./box.ts";
export { HubRelay, type HubRelayShape, type RelayServerOptions } from "./relay.ts";
export { HubRelayCore, type HubRelayCoreShape } from "./relay-core.ts";
export { WireCore, type WireCoreOptions, type WireCoreShape } from "./wire-core.ts";
export { workerdSocket, type SocketLike, type WorkerdWebSocketLike } from "./socket.ts";
export {
  type HubEventSink,
  type ThreadWorkerRef,
  type WorkerCommandResult,
  type WorkerReport,
} from "./worker-ref.ts";
export { Hub, type HubDeps, type HubEvent, type HubListener, type HubShape } from "./hub.ts";
export { HubServer, type HubServerOptions, type HubServerShape } from "./server.ts";
