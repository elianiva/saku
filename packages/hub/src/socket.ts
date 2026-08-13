/**
 * The socket surface (socket.ts): the hub's entry to the unified socket
 * module of `@saku/env` — one transport-agnostic `SocketLike` shape for
 * every connection the spine drives (the env daemon, the hub's wire and
 * relay cores, the worker's `RemoteEnv`), one workerd adapter serving
 * both of the platform's delivery models (outbound `addEventListener`
 * sockets and a DO's accepted sockets, fed through `receive`/
 * `receiveClose`), and the node `ws` adapter.
 *
 * The wire server and the relay server are written against this surface,
 * so the same connection discipline runs on node (the local spine,
 * tests) and inside a DO (production, celld). The adapter's home is
 * `packages/env/src/socket.ts`; this module re-exports it so the hub's
 * consumers keep their import (`@saku/hub/core`'s `workerdSocket`).
 */

export { workerdSocket, type SocketLike, type WorkerdWebSocketLike } from "@saku/env/remote";
