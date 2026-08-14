/**
 * The root's message union (root/message.ts): routing facts the root owns
 * (`ChangedRoute`, `Navigated`, `NavigatedTo`), the `Got*Message` wrappers
 * that lift a submodel's Message into the root's universe, the wire bridge
 * facts the root routes (session events by thread id, registry broadcasts),
 * the connection domain's messages (conn/message.ts, re-exported —
 * machine-stepped at the root, mirroring lutra's offline messages), and
 * `OpenedThread` — the shared navigation fact both submodels surface to the
 * root (the root owns URLs).
 */

import { Schema as S } from "effect";
import { Message } from "foldkit";

import * as Conn from "../conn/message.ts";
import * as Rail from "../rail/message.ts";
import * as Thread from "../thread/message.ts";
import { AppRoute } from "../route.ts";
import { SessionEventProjection } from "../thread/projection.ts";

// The connection domain (machine-stepped at the root).
export { Connected, ConnectFailed, ConnectionClosed, RetryRequested } from "../conn/message.ts";

/** The resolved URL changed (browser back/forward, a pushed URL). */
export const ChangedRoute = Message.m("ChangedRoute", { route: AppRoute });
/** A link/click requested navigation. */
export const Navigated = Message.m("Navigated", { request: S.Unknown });
/** The root pushed a URL (observability only — the URL change drives the
 *  route transition). */
export const NavigatedTo = Message.m("NavigatedTo");

/** Wraps a rail Message so the root can delegate to the rail's update. */
export const GotRailMessage = Message.m("GotRailMessage", { message: Rail.RailMessage });
/** Wraps a thread Message so the root can delegate to the pane's update. */
export const GotThreadMessage = Message.m("GotThreadMessage", { message: Thread.ThreadMessage });

// ---- wire bridge (the root subscription → root facts) ----

/** A session event streamed for some thread; the root routes it to the pane
 *  only when the route pins that thread. */
export const WireEvent = Message.m("WireEvent", {
  threadId: S.String,
  event: SessionEventProjection,
});
/** The registry broadcast (the rail's own message, re-exported). */
export { ThreadChanged } from "../rail/message.ts";
/** A connection-level wire error (unexpected); the top banner shows it. */
export const ServerErrorNotice = Message.m("ServerErrorNotice", { message: S.String });
export const DismissBanner = Message.m("DismissBanner");

/** A navigation fact: open this thread. Both the rail (a row click) and the
 *  pane (a quick start landing) surface it; the root owns URLs and reacts by
 *  pushing `/thread/:id`. Hoisted here so the two submodels share one fact
 *  (ADR 0009's informing convention). */
export const OpenedThread = Message.m("OpenedThread", { id: S.String });

export const RootMessage = S.Union([
  ChangedRoute,
  Navigated,
  NavigatedTo,
  GotRailMessage,
  GotThreadMessage,
  WireEvent,
  ServerErrorNotice,
  DismissBanner,
  Conn.Connected,
  Conn.ConnectFailed,
  Conn.ConnectionClosed,
  Conn.RetryRequested,
  Rail.ThreadChanged,
]);
export type RootMessage = S.Schema.Type<typeof RootMessage>;
