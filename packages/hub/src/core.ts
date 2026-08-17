/**
 * The hub's isolate entry (core.ts): the control-plane surface that runs
 * inside a Durable Object (Cloudflare or celld) — everything the hub DO
 * needs and nothing that binds to node.
 *
 * The module graph here is workerd-clean: the hub core, the durable
 * registry and skills store over the `KvStore` seam, the provider-neutral
 * remote-machine and env-provisioner seams, the wire and relay connection cores
 * over the `SocketLike` surface, and the worker-seam types. The node
 * WebSocket servers (server.ts, relay.ts's `HubRelay.make`) live in the
 * package's main entry; a DO feeds the cores its accepted sockets and
 * passes its own storage and secrets.
 */

export { HubError, messageOf } from "./hub-error.ts";
export {
  IdleStop,
  type IdleStopApi,
  type IdleStopController,
  type IdleStopDeps,
} from "./idle-stop.ts";
export { HubRegistry, type HubRecord, type HubRegistryApi } from "./registry.ts";
export { SkillsStore, skillNameFromSource, type SkillsStoreApi } from "./skills.ts";
export { type EnvProvisioner, type EnvProvisioning } from "./provisioner.ts";
export {
  pollUntilReady,
  RemoteMachineError,
  type CommandResult,
  type RemoteMachine,
  type RemoteMachineProvider,
  type RemoteMachineProviderError,
} from "./remote-machine.ts";
export {
  HubRelayCore,
  type HubRelayCoreApi,
  type HubRelayApi,
  type RelayServerOptions,
} from "./relay-core.ts";
export { WireCore, type WireCoreOptions, type WireCoreApi } from "./wire-core.ts";
export { workerdSocket, type SocketLike, type WorkerdWebSocketLike } from "./socket.ts";
export {
  type HubEventSink,
  type ThreadWorkerRef,
  type WorkerCommandResult,
  type WorkerReport,
} from "./worker-ref.ts";
export { Hub, type HubDeps, type HubEvent, type HubListener, type HubApi } from "./hub.ts";
