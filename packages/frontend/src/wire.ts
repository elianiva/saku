/**
 * The Wire service (wire.ts): the app's single connection manager to the
 * hub (or, transitionally, the local worker daemon).
 *
 * Built once in the layer, the service owns:
 *
 * - `client` — the current wire client. The layer's `connect()` is its only
 *   mutator, so a plain `let` is sound: JS interleaving means commands read
 *   a settled client, never a half-swapped one.
 * - `connect()` — re-resolves the bootstrap on *every* call. When the
 *   daemon restarted on a new port (a killed daemon leaves a stale URL
 *   file behind; the fresh daemon rewrites it on startup), the stale
 *   client is disposed and a new one is built for the current endpoint
 *   before connecting. When the bootstrap reports no live daemon,
 *   connect fails fast without ever dialing a socket — the offline state
 *   and the retry subscription own the wait (subscriptions.ts).
 * - `events` — a pub/sub bridge: whichever client is current forwards its
 *   wire events into one PubSub, so the subscription stream never
 *   re-attaches across client swaps and no event is dropped in the gap.
 *
 * `connect`/commands are fired from foldkit commands; wire events arrive
 * through the subscription.
 */

import { Context, Effect, Layer, PubSub, Stream } from "effect";
import {
  HelloOk,
  SessionWireEvent,
  ThreadInfo,
  WireClient,
  WireError,
  makeWireClient,
} from "@saku/wire";

import { defaultConfig, resolveConfig } from "./config.ts";

/** One wire event as the bridge forwards it (kind + payload, pre-projection). */
export type BridgeEvent =
  | { readonly _tag: "event"; readonly threadId: string; readonly event: SessionWireEvent }
  | { readonly _tag: "thread_changed"; readonly thread: ThreadInfo }
  | { readonly _tag: "error"; readonly message: string }
  | { readonly _tag: "close" };

export interface WireShape {
  /** The current client; always a settled, connectable value. */
  readonly client: WireClient;
  /** Re-resolve the bootstrap, swap the client when the endpoint changed, connect. */
  readonly connect: () => Effect.Effect<HelloOk, WireError, never>;
  /** Wire events from the current client, forwarded across client swaps. */
  readonly events: Stream.Stream<BridgeEvent, never, never>;
}

export class Wire extends Context.Service<Wire, WireShape>()("saku/Wire") {}

/** Every connect attempt fails with this while the bootstrap reports no daemon. */
const daemonOffline = () =>
  new WireError({
    code: "refused",
    message: "the local daemon is offline — start it with: saku daemon start",
  });

export const WireLive = Layer.effect(
  Wire,
  Effect.gen(function* () {
    // The eager client exists from boot so the service always holds one;
    // connect() re-resolves and swaps it as the daemon's endpoint moves.
    const boot = yield* resolveConfig;
    const bootEndpoint = boot._tag === "offline" ? defaultConfig() : boot.endpoint;
    let current = yield* makeWireClient({
      url: bootEndpoint.url,
      token: bootEndpoint.token,
      role: "cli",
    });
    let currentEndpoint = bootEndpoint;

    // The bridge: listeners on the current client forward into one PubSub.
    // `attach` replaces the listener set; the layer is its only caller.
    const pubsub = yield* PubSub.unbounded<BridgeEvent>();
    let detach: () => void = () => {};
    const attach = (client: WireClient) =>
      Effect.sync(() => {
        detach();
        const offs = [
          client.on("event", (payload) => {
            void Effect.runFork(
              PubSub.publish(pubsub, {
                _tag: "event",
                threadId: payload.threadId,
                event: payload.event,
              }),
            );
          }),
          client.on("thread_changed", (thread) => {
            void Effect.runFork(PubSub.publish(pubsub, { _tag: "thread_changed", thread }));
          }),
          client.on("error", (payload) => {
            void Effect.runFork(
              PubSub.publish(pubsub, { _tag: "error", message: payload.message }),
            );
          }),
          client.on("close", () => {
            void Effect.runFork(PubSub.publish(pubsub, { _tag: "close" }));
          }),
        ];
        detach = () => offs.forEach((off) => off());
      });
    yield* attach(current);

    const connect = Effect.fn("connect")(function* () {
      const resolved = yield* resolveConfig;
      if (resolved._tag === "offline") {
        return yield* Effect.fail(daemonOffline());
      }
      const endpoint = resolved.endpoint;
      if (endpoint.url !== currentEndpoint.url) {
        // The daemon restarted on a new port; the stale client's socket
        // can never come back. Dispose it and swap in a fresh one.
        yield* current.disconnect();
        current = yield* makeWireClient({
          url: endpoint.url,
          token: endpoint.token,
          role: "cli",
        });
        currentEndpoint = endpoint;
        yield* attach(current);
      }
      return yield* current.connect();
    });

    return {
      get client() {
        return current;
      },
      connect,
      events: Stream.fromPubSub(pubsub),
    };
  }),
);
