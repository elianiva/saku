/**
 * The hub's isolate entry (core.ts): the control-plane surface that runs
 * inside a Durable Object (Cloudflare or celld) — everything the hub DO
 * needs and nothing that binds to node.
 *
 * The module graph here is workerd-clean: the hub core, the durable
 * registry and skills store over the `KvStore` seam, the Box API client
 * and provisioner (injectable fetch), the wire and relay connection cores
 * over the `SocketLike` surface, and the worker-seam types. The node
 * WebSocket servers (server.ts, relay.ts's `HubRelay.make`) live in the
 * package's main entry; a DO feeds the cores its accepted sockets and
 * passes its own storage and secrets.
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
export {
  HubRelayCore,
  type HubRelayCoreShape,
  type HubRelayShape,
  type RelayServerOptions,
} from "./relay-core.ts";
export { WireCore, type WireCoreOptions, type WireCoreShape } from "./wire-core.ts";
export { workerdSocket, type SocketLike, type WorkerdWebSocketLike } from "./socket.ts";
export {
  type HubEventSink,
  type ThreadWorkerRef,
  type WorkerCommandResult,
  type WorkerReport,
} from "./worker-ref.ts";
export { Hub, type HubDeps, type HubEvent, type HubListener, type HubShape } from "./hub.ts";
