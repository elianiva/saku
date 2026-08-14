/** The relay as a node WebSocket server (the local spine, tests). */

import { Effect, Scope } from "effect";

import { listenWs, wsUrlOf } from "@saku/wire/server";

import { makeHubRelayCore } from "./relay-core.ts";
import type { HubRelayShape, RelayServerOptions } from "./relay-core.ts";
export type { HubRelayShape, RelayServerOptions } from "./relay-core.ts";

export const makeHubRelay = Effect.fn("makeHubRelay")(function* (options: RelayServerOptions) {
  const log = options.log ?? (() => Effect.void);
  const core = yield* makeHubRelayCore({ token: options.token, log });
  // listenWs owns the server's lifetime: it resolves once the server is
  // listening and closes it when the scope closes (interruption) — the
  // scope requirement stays so the server's teardown is always owned.
  const server = yield* listenWs<Error>({
    onConnection: (socket) => core.handleConnection(socket as never),
    onError: (error) => {
      // The listenWs mapper is a sync callback: fork the log.
      void Effect.runFork(log(`relay error: ${error.message}`));
      return error;
    },
  });
  const url = wsUrlOf(server);
  const close = (): Effect.Effect<void, never> => core.close();
  return {
    url,
    registered: core.registered,
    close,
  };
});
