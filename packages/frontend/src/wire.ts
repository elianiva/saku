/**
 * The Wire service (wire.ts): the app's single typed client to the hub.
 *
 * Built once in the layer: config resolution (dev bootstrap → saved override
 * → same-origin default), then `makeWireClient` — an effect-machine actor
 * whose fiber outlives individual commands (it runs on the global runtime,
 * so no scope plumbing). `connect`/commands are fired from foldkit commands;
 * wire events arrive through the subscription.
 */

import { Context, Effect, Layer } from "effect";
import { makeWireClient, type WireClient } from "@saku/wire";

import { resolveConfig } from "./config.ts";

export class Wire extends Context.Service<Wire, { readonly client: WireClient }>()("saku/Wire") {}

export const WireLive = Layer.effect(
  Wire,
  Effect.gen(function* () {
    const config = yield* resolveConfig;
    const client = yield* makeWireClient({
      url: config.url,
      token: config.token,
      role: "cli",
    });
    return { client };
  }),
);
