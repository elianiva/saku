/** The relay as a node WebSocket server (the local spine, tests). */

import { Context, Effect } from "effect";

import { listenWs, wsUrlOf } from "@saku/wire/server";

import { HubRelayCore } from "./relay-core.ts";
import type { HubRelayApi, RelayServerOptions } from "./relay-core.ts";

export type { HubRelayApi, RelayServerOptions } from "./relay-core.ts";

/** The relay as a node WebSocket server (the local spine, tests). */
export class HubRelay extends Context.Service<HubRelay, HubRelayApi>()("HubRelay", {
  make: Effect.fn("HubRelay.make")(function* (options: RelayServerOptions) {
    const log = options.log ?? (() => Effect.void);
    const core = yield* HubRelayCore.make({ log, token: options.token });
    // listenWs owns the server's lifetime: it resolves once the server is
    // listening and closes it when the scope closes (interruption) — the
    // scope requirement stays so the server's teardown is always owned.
    const server = yield* listenWs<Error>({
      onConnection: (socket) => {
        core.handleConnection(socket);
      },
      onError: (error) => {
        // The listenWs mapper is a sync callback: fork the log.
        void Effect.runFork(log(`relay error: ${error.message}`));
        return error;
      },
    });
    const url = wsUrlOf(server);
    const close = () => core.close();
    return {
      close,
      registered: core.registered,
      url,
    };
  }),
}) {}
