/** The relay as a node WebSocket server (the local spine, tests). */

import { WebSocketServer } from "ws";
import { Effect, Ref, Scope } from "effect";

import { makeHubRelayCore } from "./relay-core.ts";
import type { HubRelayShape, RelayServerOptions } from "./relay-core.ts";
export type { HubRelayShape, RelayServerOptions } from "./relay-core.ts";

export const makeHubRelay = (
  options: RelayServerOptions,
): Effect.Effect<HubRelayShape, Error, Scope.Scope> =>
  Effect.gen(function* () {
    const log = options.log ?? (() => {});
    const core = yield* makeHubRelayCore({ token: options.token, log });
    const server = yield* Effect.callback<WebSocketServer, Error>((resume) => {
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      server.on("connection", (socket) => core.handleConnection(socket as never));
      server.on("error", (error) => {
        log(`relay error: ${error.message}`);
        resume(Effect.fail(error));
      });
      server.on("listening", () => resume(Effect.succeed(server)));
      return Effect.sync(() => {
        server.close();
      });
    });
    const address = server.address();
    const url =
      address !== null && typeof address !== "string" ? `ws://127.0.0.1:${address.port}` : "";
    const close = (): Effect.Effect<void, never> => core.close();
    return {
      url,
      registered: core.registered,
      close,
    };
  });
