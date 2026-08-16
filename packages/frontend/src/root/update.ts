/**
 * The root's update loop (root/update.ts): routing facts and the conn
 * machine are handled here; a `Got*Message` delegates to the owning
 * submodel's `update` and lifts the results. The root owns navigation, so
 * it reacts to the rail's `OpenedThread`/`DeletedThread` and the pane's
 * `OpenedThread` (a quick start landing) OutMessages by pushing URLs. The
 * wire bridge facts are routed: session events reach the pane only when
 * the route pins their thread; registry broadcasts reach the rail always
 * and the pane when they are its thread (the header's info).
 */

import { Match as M, Option } from "effect";
import { Command } from "foldkit";
import { evo } from "foldkit/struct";

import { connMachine } from "../conn/machine.ts";
import * as Rail from "../rail/update.ts";
import type * as RailMsg from "../rail/message.ts";
import type { AppRoute } from "../route.ts";
import { LoadStateCmd, LoadTrailCmd } from "../thread/command.ts";
import * as Thread from "../thread/update.ts";
import * as ThreadMsg from "../thread/message.ts";
import type { Wire } from "../wire.ts";
import { NavigateToCmd } from "./command.ts";
import { GotRailMessage, GotThreadMessage, ThreadChanged } from "./message.ts";
import type { RootMessage } from "./message.ts";
import type { Model } from "./model.ts";

export type Commands = readonly Command.Command<RootMessage, never, Wire>[];
export type UpdateReturn = readonly [Model, Commands];

const none: Commands = [];

/** Delegate a rail message; the rail's OutMessage becomes navigation. */
const delegateToRail = (model: Model, railMessage: RailMsg.RailMessage): UpdateReturn => {
  const [nextRail, cmds, out] = Rail.update(model.rail, railMessage);
  const mapped = Command.mapMessages(cmds, (m) => GotRailMessage({ message: m }));
  return Option.match(out, {
    onNone: () => [evo(model, { rail: (_) => nextRail }), mapped],
    onSome: (surfaced) => {
      // The rail surfaced a navigation fact; the root owns URLs. Deleting
      // the pinned thread leaves the route; opening one pushes its URL.
      let navigation: Commands;
      if (surfaced._tag === "OpenedThread") {
        navigation = [NavigateToCmd({ path: `/thread/${surfaced.id}` })];
      } else if (model.route._tag === "Thread" && model.route.id === surfaced.id) {
        navigation = [NavigateToCmd({ path: "/" })];
      } else {
        navigation = [];
      }
      return [evo(model, { rail: (_) => nextRail }), [...mapped, ...navigation]];
    },
  });
};

/** Delegate a thread message; the pane's OutMessage becomes navigation. */
const delegateToThread = (model: Model, threadMessage: ThreadMsg.ThreadMessage): UpdateReturn => {
  const [nextThread, cmds, out] = Thread.update(model.thread, threadMessage);
  const mapped = Command.mapMessages(cmds, (m) => GotThreadMessage({ message: m }));
  return Option.match(out, {
    onNone: () => [evo(model, { thread: (_) => nextThread }), mapped],
    onSome: (surfaced) => {
      // The pane surfaced a navigation fact (a quick start opened a
      // thread, or the new-thread button asked for the welcome); the root
      // owns URLs.
      let navigation: Commands;
      if (surfaced._tag === "OpenedThread") {
        navigation = [NavigateToCmd({ path: `/thread/${surfaced.id}` })];
      } else if (surfaced._tag === "NewThreadRequested") {
        navigation = [NavigateToCmd({ path: "/" })];
      } else {
        navigation = [];
      }
      return [evo(model, { thread: (_) => nextThread }), [...mapped, ...navigation]];
    },
  });
};

/** The route changed (back/forward, a pushed URL): the route is the single
 *  source of truth; both submodels derive their route-owned fields. */
const applyRoute = (model: Model, route: AppRoute): UpdateReturn => {
  const [nextThread, threadCmds] = Thread.informRouteChanged(model.thread, route);
  return [
    evo(model, {
      rail: (_) => Rail.informRouteChanged(model.rail, route),
      route: (_) => route,
      thread: (_) => nextThread,
    }),
    Command.mapMessages(threadCmds, (m) => GotThreadMessage({ message: m })),
  ];
};

/** Step the conn machine; its transition commands ride along (a retry
 *  reconnects, a successful connect re-lists the registry). */
const stepConn = (model: Model, message: RootMessage): UpdateReturn => {
  const result = connMachine.step(model.conn, message);
  return [
    evo(model, { conn: (_) => result.state }),
    result._tag === "Transitioned" ? result.commands : none,
  ];
};

export const update = (model: Model, message: RootMessage) =>
  M.value(message).pipe(
    M.withReturnType<UpdateReturn>(),
    M.tagsExhaustive({
      ChangedRoute: ({ route }) => applyRoute(model, route),
      ConnectFailed: (m) => stepConn(model, m),

      // A successful connect also clears the wire-error banner. The pane's
      // reads are re-issued on the transition: at boot they race the
      // handshake (a pinned thread's trail read can land on a
      // not-yet-connected client and fail without a retry), and after a
      // reconnect the trail is stale (events streamed while offline were
      // missed). The state read doubles as the header's info — a thread
      // opened mid-run must show its state and the stop control.
      Connected: (m) => {
        const result = connMachine.step(model.conn, m);
        // The pane's reads ride the transition to Online: at boot they race
        // the handshake (a pinned thread's trail read can land on a
        // not-yet-connected client and fail without a retry), and after a
        // reconnect the trail is stale (events streamed while offline were
        // missed). The state read doubles as the header's info — a thread
        // opened mid-run must show its state and the stop control.
        const reload =
          result._tag === "Transitioned" && model.route._tag === "Thread"
            ? Command.mapMessages(
                // SAFETY: both commands are thread-scoped (TrailLoaded /
                // StateLoaded); the annotation widens the literal so
                // mapMessages types the callback over the union.
                [
                  LoadTrailCmd({ id: model.route.id }),
                  LoadStateCmd({ id: model.route.id }),
                ] as readonly Command.Command<ThreadMsg.ThreadMessage, never, Wire>[],
                (threadMessage) => GotThreadMessage({ message: threadMessage }),
              )
            : none;
        return [
          evo(model, { banner: (_) => null, conn: (_) => result.state }),
          [...(result._tag === "Transitioned" ? result.commands : none), ...reload],
        ];
      },
      ConnectionClosed: (m) => stepConn(model, m),

      DismissBanner: () => [evo(model, { banner: (_) => null }), none],

      GotRailMessage: ({ message: railMessage }) => delegateToRail(model, railMessage),
      GotThreadMessage: ({ message: threadMessage }) => delegateToThread(model, threadMessage),

      Navigated: () => [model, none],
      NavigatedTo: () => [model, none],

      RetryRequested: (m) => stepConn(model, m),

      // A session event: route it to the pane only when the route pins its
      // thread (the pane never sees other threads' streams).
      ServerErrorNotice: ({ message: notice }) => [evo(model, { banner: (_) => notice }), none],
      // The registry broadcast: the rail upserts; the pane refreshes its
      // header info when the broadcast is its thread.
      ThreadChanged: ({ thread }) => {
        const [withRail, cmds] = delegateToRail(model, ThreadChanged({ thread }));
        if (model.thread.id !== thread.id) {
          return [withRail, cmds];
        }
        const [next, threadCmds] = delegateToThread(withRail, ThreadMsg.ThreadChanged({ thread }));
        return [next, [...cmds, ...threadCmds]];
      },

      WireEvent: ({ threadId, event }) =>
        model.route._tag === "Thread" && model.route.id === threadId
          ? delegateToThread(model, ThreadMsg.SessionEvent({ event }))
          : [model, none],
    }),
  );
