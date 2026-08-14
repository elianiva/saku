/**
 * The hub's wire server (server.ts): WebSocket JSONL transport for the hub
 * core (ADR 0004) — the same connection discipline the local daemon runs:
 * hello/version handshake, token auth, stateless command routing, and
 * fan-out of `thread_changed` + session events to every authed console.
 *
 * The server is a thin adapter: all semantics live in the `WireCoreShape`
 * it wraps (routing, registry, skills, worker seam); the DO adapter of M4
 * drives the same core over a Durable Object's accepted sockets. The env
 * relay (M3) serves on its own port; the DO adapter multiplexes both
 * behind the single domain.
 *
 * Startup failures are defects by design, matching the `makeSakuDaemon`
 * contract: a server that cannot bind fails hard (the `listenWs` error
 * path maps to `HubError` kind `startup`) — the process's fatal path,
 * never a silent half-up server.
 */

import type { WebSocket, WebSocketServer } from "ws";
import { Effect, Option, Ref, Scope } from "effect";

import { listenWs, wsUrlOf } from "@saku/wire/server";

import type { HubShape } from "./hub.ts";
import { HubError } from "./hub-error.ts";
import { makeWireCore, type WireCoreShape } from "./wire-core.ts";
import { makeHubRelay, type HubRelayShape } from "./relay.ts";
import type { SocketLike } from "./socket.ts";

/** A node `ws` socket satisfies the hub's `SocketLike` surface directly. */
const asSocketLike = (socket: WebSocket): SocketLike => socket as unknown as SocketLike;

export interface HubServerOptions {
  readonly hub: HubShape;
  /** The deployment secret, presented in `hello` (v1: single-owner auth). */
  readonly token: string;
  /** Serve the env relay too (the daemons' outbound registration). */
  readonly relay?: boolean;
}

export interface HubServerShape {
  /** The ws:// URL the hub listens on (consoles). */
  readonly url: string;
  /** The ws:// URL the env relay listens on (daemons + workers). */
  readonly relayUrl: string | null;
  /** Stop the server: drop clients, unsubscribe, close the sockets. */
  readonly close: () => Effect.Effect<void, never>;
}

/**
 * Build the wire server: the connection core, then the node WebSocket
 * server that feeds it sockets. Mirrors the local daemon's `makeSakuDaemon`
 * — the two implementations of the wire's server side share the connection
 * discipline, so the protocol's contract is exercised by both until the
 * rework lands (plan 0001).
 */
export const makeHubServer = Effect.fn("makeHubServer")(function* (options: HubServerOptions) {
  const { hub, token } = options;
  // The env relay: a separate port for M3 (the DO adapter of M4
  // multiplexes both behind the deployment's domain).
  const relay: Option.Option<HubRelayShape> =
    options.relay === true
      ? Option.some(
          yield* makeHubRelay({ token }).pipe(
            // The relay's raw socket failures are hub startup failures.
            Effect.mapError(
              (error) =>
                new HubError({
                  kind: "startup",
                  message: `relay: ${error instanceof Error ? error.message : String(error)}`,
                  cause: error,
                }),
            ),
          ),
        )
      : Option.none();
  const core: WireCoreShape = yield* makeWireCore({ hub, token });
  const closedRef = yield* Ref.make(false);
  const serverRef = yield* Ref.make<Option.Option<WebSocketServer>>(Option.none());

  const log = (message: string): Effect.Effect<void, never, never> =>
    Effect.logError(`[saku-hub] ${message}`);

  const close = Effect.fn("close")(function* () {
    const closed = yield* Ref.get(closedRef);
    if (closed) return;
    yield* Ref.set(closedRef, true);
    yield* core.close();
    const server = yield* Ref.get(serverRef);
    if (Option.isSome(server)) {
      yield* Effect.callback<void>((resume) => {
        server.value.close(() => resume(Effect.void));
        return Effect.void;
      });
    }
    if (Option.isSome(relay)) {
      yield* relay.value.close();
    }
  });

  // listenWs owns the server's lifecycle: it resolves once the server is
  // listening and closes it when the scope closes (interruption).
  const server = yield* listenWs<HubError>({
    onConnection: (socket) => {
      // The connection handler lives for the socket's lifetime; the scope
      // closes with the socket (the runConnection finalizer drops the client).
      void Effect.runFork(core.runConnection(asSocketLike(socket)).pipe(Effect.scoped));
    },
    onError: (error) => {
      // The listenWs mapper is a sync callback: fork the log.
      void Effect.runFork(log(`server error: ${error.message}`));
      return new HubError({ kind: "startup", message: error.message, cause: error });
    },
  });
  yield* Ref.set(serverRef, Option.some(server));
  yield* Effect.addFinalizer(() => close());
  return {
    url: wsUrlOf(server),
    relayUrl: Option.isSome(relay) ? relay.value.url : null,
    close,
  };
});
