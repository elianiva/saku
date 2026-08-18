/**
 * The wire's node WebSocket server (ws-server.ts): the `listenWs`/
 * `wsUrlOf` helpers that the hub's wire server, the env relay, and the
 * local daemon all use to serve on an ephemeral loopback port.
 *
 * The discipline is the one the three call sites used to duplicate:
 * `Effect.callback<WebSocketServer, E>` with the error/listening handlers
 * and the close-on-interrupt finalizer, plus the `server.address()`
 * URL derivation. Startup failures (bind errors, no listening address)
 * fail with the caller's tagged error via `onError`; the server closes on
 * interruption and on failure.
 *
 * This module is node-only (`ws`) — it is exported through the
 * `@saku/wire/server` subpath and never through the main entry, which the
 * frontend bundles for the browser.
 */

import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { Effect, Schema } from "effect";

/**
 * A synthesized server startup failure: the listener came up without an
 * address (unreachable for a loopback TCP listener, but a startup failure
 * when it happens — tagged so the callers' `onError` mappers stay
 * structural, never message-matched).
 */
// Aliased so the TaggedError class declaration below stays a plain call
// (oxlint's throw-new-error would demand `new`, which breaks the schema
// typecheck — `TaggedError` is a function returning a class, not a class).
const tagged = Schema.TaggedError;

/** The ws-server error kinds (`WsServerError.kind`) — single source of truth. */
export const WsServerErrorKinds = Schema.Literals(["no_address"] as const);

export type WsServerErrorKind = typeof WsServerErrorKinds.Type;

export class WsServerError extends tagged<WsServerError>()("WsServerError", {
  kind: WsServerErrorKinds,
  message: Schema.String,
}) {}

/** Whether the listening address is a TCP port (loopback never yields a pipe name). */
const isAddressObject = (address: AddressInfo | string | null): address is AddressInfo =>
  address !== null && typeof address !== "string";

/** Listen on an ephemeral loopback port; resolves once listening. Startup failures fail with the caller's tagged error via onError. The server closes on interruption/failure. */
export const listenWs = <E>(options: {
  readonly onConnection: (socket: WebSocket) => void;
  readonly onError: (error: Error) => E;
}) =>
  Effect.callback<WebSocketServer, E>((resume) => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("connection", options.onConnection);
    server.on("error", (error) => {
      // A bind failure is a startup failure: close and fail with the
      // caller's tagged error (the daemon's DaemonError, the hub's HubError).
      server.close();
      resume(Effect.fail(options.onError(error)));
    });
    server.on("listening", () => {
      const address = server.address();
      if (!isAddressObject(address)) {
        // Unreachable for a TCP loopback listener; still a startup failure.
        server.close();
        resume(
          Effect.fail(
            options.onError(
              new WsServerError({ kind: "no_address", message: "no listening address" }),
            ),
          ),
        );
        return;
      }
      resume(Effect.succeed(server));
    });
    // The interrupt finalizer: a program that stops mid-listen takes the
    // server down with it.
    return Effect.sync(() => {
      server.close();
    });
  });

/** "ws://127.0.0.1:PORT" for a listening server ("" when unavailable). */
export const wsUrlOf = (server: WebSocketServer) => {
  const address = server.address();
  return isAddressObject(address) ? `ws://127.0.0.1:${address.port}` : "";
};
