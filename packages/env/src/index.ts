/**
 * @saku/env — the env daemon: the hands of the managed-agents spine
 * (ADR 0003). One binary, one protocol — the pi tool surface
 * (`read`/`bash`/`edit`/`write`) over WebSocket JSONL — running on the
 * user's machine (local mode, reached through the hub's relay) or inside
 * a Box (sandbox mode, exposed through the box's private `host` URL).
 *
 * - `protocol.ts` — the env protocol: hello/version, the ops (pi's
 *   `ExecutionEnv` surface verbatim), streamed exec output, error classes
 * - `local-env.ts` — the tool engine: `ExecutionEnv` over the effect
 *   `FileSystem` service, bound to a connection's workspace
 * - `daemon.ts` — the server: token-gated WebSocket, one `LocalEnv` per
 *   connection, the shared connection handler
 * - `remote.ts` — `RemoteEnv`: the worker's `ExecutionEnv` over the wire
 *   (direct host URL, or attached through the hub's relay)
 * - `relay.ts` — the daemon's outbound registration with the hub (no open
 *   ports on the user's machine)
 */

export {
  ENV_VERSION,
  EnvHello,
  EnvHelloOk,
  EnvRequest,
  EnvStream,
  EnvAbort,
  EnvResponseOk,
  EnvResponseError,
  EnvErrorFrame,
  RelayHello,
  RelayAttach,
  EnvOp,
  EnvPayloadSchema,
  EnvFileInfo,
  EnvFileKind,
  toPiError,
} from "./protocol.ts";
export type {
  EnvError,
  EnvOp as EnvOpType,
  EnvFileInfo as EnvFileInfoType,
  EnvHandle,
  EnvHello as EnvHelloType,
  EnvHelloOk as EnvHelloOkType,
  EnvErrorFrame as EnvErrorFrameType,
  RelayHello as RelayHelloType,
  RelayAttach as RelayAttachType,
} from "./protocol.ts";
export { LocalEnv } from "./local-env.ts";
export {
  makeEnvDaemon,
  handleEnvConnection,
  type EnvDaemonOptions,
  type EnvDaemonShape,
  type EnvConnectionContext,
} from "./daemon.ts";
export {
  RemoteEnv,
  workerdSocket,
  workerdSocketFactory,
  type SocketLike,
  type WorkerdWebSocketLike,
  type RemoteEnvOptions,
} from "./remote.ts";
export { nodeSocket } from "./remote-node.ts";
export { makeEnvRelayClient, type RelayClientOptions, type RelayClientShape } from "./relay.ts";
export * from "./paths.ts";
