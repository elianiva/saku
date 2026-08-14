/**
 * The console's subscriptions (subscriptions.ts): the bridge from the wire
 * client's events into the TEA world, and the offline retry loop.
 *
 * One persistent stream drains the Wire service's event bridge (wire.ts)
 * and forwards every payload as a message: session events (filtered by
 * thread in update), registry broadcasts, connection-level errors, and the
 * close signal. Because the bridge re-attaches across client swaps, this
 * stream never restarts.
 *
 * The retry entry is model-driven: while the connection is offline it
 * ticks every two seconds and fires `RetryRequested`; `update` re-runs the
 * connect command, which re-resolves the bootstrap — so a daemon that
 * comes back (on a new port, with its URL file rewritten) is picked up
 * without a page reload.
 */

import { Stream, Schema as S } from "effect";
import { Subscription } from "foldkit";

import {
  ConnectionClosed,
  RetryRequested,
  ServerErrorNotice,
  ThreadChanged,
  WireEvent,
  type AppMessage,
} from "./message.ts";
import type { Model } from "./model.ts";
import { decodeSessionEvent } from "./projection.ts";
import { Wire, type BridgeEvent } from "./wire.ts";

/** The pause between automatic reconnect attempts while offline. */
const RETRY_INTERVAL = "2 seconds";

/** One bridged wire event, projected into the app's message vocabulary. */
const bridgeToMessage = (event: BridgeEvent): AppMessage => {
  switch (event._tag) {
    case "event":
      // Decode at the boundary: the wire's TS-typed event becomes the
      // console's schema projection (ADR 0005) before anything folds it.
      return WireEvent({
        threadId: event.threadId,
        event: decodeSessionEvent(event.event),
      });
    case "thread_changed":
      return ThreadChanged({ thread: event.thread });
    case "error":
      return ServerErrorNotice({ message: event.message });
    case "close":
      return ConnectionClosed();
  }
};

export const subscriptions = Subscription.make<Model, AppMessage, Wire>()((entry) => ({
  wire: Subscription.persistent(
    Stream.service(Wire).pipe(
      Stream.flatMap(({ events }) => events.pipe(Stream.map(bridgeToMessage))),
    ),
  ),
  // While offline: reconnect every RETRY_INTERVAL. The first tick is
  // dropped — the failure that made us offline already ran one attempt,
  // and an immediate tick would busy-loop the connection.
  retry: entry(
    { offline: S.Boolean },
    {
      modelToDependencies: (model) => ({ offline: model.conn._tag === "offline" }),
      dependenciesToStream: ({ offline }) =>
        offline
          ? Stream.tick(RETRY_INTERVAL).pipe(
              Stream.drop(1),
              Stream.map(() => RetryRequested()),
            )
          : Stream.empty,
    },
  ),
}));
