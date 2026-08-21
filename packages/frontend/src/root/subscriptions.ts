/**
 * The root's subscriptions (root/subscriptions.ts): the bridge from the wire
 * client's events into the TEA world, and the offline retry loop.
 *
 * One persistent stream drains the Wire service's event bridge (wire.ts)
 * and forwards every payload as a root message: session events (routed by
 * thread in root update), registry broadcasts, connection-level errors, and
 * the close signal. Because the bridge re-attaches across client swaps,
 * this stream never restarts.
 *
 * The retry entry is model-driven: while the connection is offline it
 * ticks every two seconds and fires `RetryRequested`; the conn machine
 * (conn/machine.ts) moves back to Connecting and re-runs the connect
 * command, which re-resolves the bootstrap — so a daemon that comes back
 * (on a new port, with its URL file rewritten) is picked up without a page
 * reload.
 */

import { Match, Stream, Schema as S } from "effect";
import { Subscription } from "foldkit";

import { decodeSessionEvent } from "../thread/projection.ts";
import { NoticeDismissed } from "../thread/message.ts";
import { Wire } from "../wire.ts";
import type { BridgeEvent } from "../wire.ts";
import {
  ConnectionClosed,
  GotThreadMessage,
  RetryRequested,
  ServerErrorNotice,
  ThreadChanged,
  WireEvent,
} from "./message.ts";
import type { RootMessage } from "./message.ts";
import type { Model } from "./model.ts";

/** The pause between automatic reconnect attempts while offline. */
const RETRY_INTERVAL = "2 seconds";
/** How long a failure notice lives without interaction (then it dismisses itself). */
const NOTICE_TTL = "8 seconds";

/** One bridged wire event, projected into the root's message vocabulary. */
const bridgeToMessage = (event: BridgeEvent) =>
  Match.value(event).pipe(
    Match.tagsExhaustive({
      close: () => ConnectionClosed(),
      error: (notice) => ServerErrorNotice({ message: notice.message }),
      event: (wireEvent) =>
        // Decode at the boundary: the wire's TS-typed event becomes the
        // console's schema projection (ADR 0005) before anything folds it.
        WireEvent({
          event: decodeSessionEvent(wireEvent.event),
          threadId: wireEvent.threadId,
        }),
      thread_changed: (changed) => ThreadChanged({ thread: changed.thread }),
    }),
  );

export const subscriptions = Subscription.make<Model, RootMessage, Wire>()((entry) => ({
  // While offline: reconnect every RETRY_INTERVAL. The first tick is
  // dropped — the failure that made us offline already ran one attempt,
  // and an immediate tick would busy-loop the connection.
  retry: entry(
    { offline: S.Boolean },
    {
      dependenciesToStream: ({ offline }) =>
        offline
          ? Stream.tick(RETRY_INTERVAL).pipe(
              Stream.drop(1),
              Stream.map(() => RetryRequested()),
            )
          : Stream.empty,
      modelToDependencies: (model) => ({ offline: model.conn._tag === "Offline" }),
    },
  ),
  // A failure notice expires: after NOTICE_TTL it dismisses itself, so a
  // stale error never outlives its moment (route changes clear it too;
  // this covers the thread that just... sits there).
  noticeExpiry: entry(
    { hasNotice: S.Boolean },
    {
      dependenciesToStream: ({ hasNotice }) =>
        hasNotice
          ? Stream.tick(NOTICE_TTL).pipe(
              Stream.drop(1),
              Stream.map(() => GotThreadMessage({ message: NoticeDismissed() })),
            )
          : Stream.empty,
      modelToDependencies: (model) => ({ hasNotice: model.thread.notice !== null }),
    },
  ),
  wire: Subscription.persistent(
    Stream.service(Wire).pipe(
      Stream.flatMap(({ events }) => events.pipe(Stream.map(bridgeToMessage))),
    ),
  ),
}));
