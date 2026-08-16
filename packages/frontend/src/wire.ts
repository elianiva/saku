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
 *   wire events into one PubSub through a per-client event stream (the
 *   listeners register and deregister with the stream's scope), so the
 *   subscription stream never re-attaches across client swaps and no event
 *   is dropped in the gap.
 *
 * `connect`/commands are fired from foldkit commands; wire events arrive
 * through the subscription.
 */

import { Context, Data, Effect, Fiber, Layer, PubSub, Queue, Stream } from "effect";
import type { HelloOk, SessionWireEvent, ThreadInfo, WireClientApi } from "@saku/wire";
import { WireClient, WireError } from "@saku/wire";

import { defaultConfig, resolveConfig } from "./config.ts";

/** One wire event as the bridge forwards it (kind + payload, pre-projection). */
export type BridgeEvent = Data.TaggedEnum<{
  event: { threadId: string; event: SessionWireEvent };
  thread_changed: { thread: ThreadInfo };
  error: { message: string };
  close: Record<never, never>;
}>;
/** The bridge event constructors — one per kind, from the same definition. */
export const BridgeEvent = Data.taggedEnum<BridgeEvent>();

export interface WireApi {
  /** The current client; always a settled, connectable value. */
  readonly client: WireClientApi;
  /** Re-resolve the bootstrap, swap the client when the endpoint changed, connect. */
  readonly connect: () => Effect.Effect<HelloOk, WireError>;
  /** Wire events from the current client, forwarded across client swaps. */
  readonly events: Stream.Stream<BridgeEvent>;
}

export class Wire extends Context.Service<Wire, WireApi>()("saku/Wire") {}

export const WireLive = Layer.effect(
  Wire,
  Effect.gen(function* WireLive() {
    // The eager client exists from boot so the service always holds one;
    // connect() re-resolves and swaps it as the daemon's endpoint moves.
    const boot = yield* resolveConfig;
    const bootEndpoint = boot._tag === "offline" ? defaultConfig() : boot.endpoint;
    let current = yield* WireClient.make({
      role: "cli",
      token: bootEndpoint.token,
      url: bootEndpoint.url,
    });
    let currentEndpoint = bootEndpoint;

    // The bridge: the current client's events flow through one PubSub, so
    // the subscription stream never re-attaches across client swaps and no
    // event is dropped in the gap. Each client's listeners register when
    // its event stream's scope opens and deregister when it closes (the
    // acquireRelease shape foldkit's fromEvent helpers use for DOM
    // targets); `attach` forks that stream and awaits the previous bridge's
    // interrupt, so the old listeners are gone before the new ones attach.
    const pubsub = yield* PubSub.unbounded<BridgeEvent>();

    /** One client's wire events as a stream (foldkit's listener-to-stream
     *  shape): the listeners register on scope open, deregister on close. */
    const eventsOf = (client: WireClientApi) =>
      Stream.callback<BridgeEvent>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const offs = [
              client.on("event", (payload) => {
                Queue.offerUnsafe(
                  queue,
                  BridgeEvent.event({ event: payload.event, threadId: payload.threadId }),
                );
              }),
              client.on("thread_changed", (thread) => {
                Queue.offerUnsafe(queue, BridgeEvent.thread_changed({ thread }));
              }),
              client.on("error", (payload) => {
                Queue.offerUnsafe(queue, BridgeEvent.error({ message: payload.message }));
              }),
              client.on("close", () => {
                Queue.offerUnsafe(queue, BridgeEvent.close());
              }),
            ];
            return () => {
              for (const off of offs) {
                off();
              }
            };
          }),
          (dispose) => Effect.sync(dispose),
        ).pipe(Effect.flatMap(() => Effect.never)),
      );

    let bridge: Fiber.Fiber<void> | null = null;
    const attach = (client: WireClientApi) =>
      Effect.gen(function* attachEvents() {
        if (bridge !== null) {
          yield* Fiber.interrupt(bridge);
        }
        bridge = yield* Effect.forkDetach(
          Stream.runDrain(
            eventsOf(client).pipe(Stream.tap((event) => PubSub.publish(pubsub, event))),
          ),
        );
      });
    yield* attach(current);

    const connect = Effect.fn("connect")(function* connect() {
      const resolved = yield* resolveConfig;
      if (resolved._tag === "offline") {
        return yield* Effect.fail(
          new WireError({
            code: "refused",
            message: "the local daemon is offline — start it with: saku daemon start",
          }),
        );
      }
      const { endpoint } = resolved;
      if (endpoint.url !== currentEndpoint.url) {
        // The daemon restarted on a new port; the stale client's socket
        // can never come back. Dispose it and swap in a fresh one.
        yield* current.disconnect();
        current = yield* WireClient.make({
          role: "cli",
          token: endpoint.token,
          url: endpoint.url,
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
