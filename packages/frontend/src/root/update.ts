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
import * as RailMsg from "../rail/message.ts";
import { AppRoute } from "../route.ts";
import * as Thread from "../thread/update.ts";
import * as ThreadMsg from "../thread/message.ts";
import { Wire } from "../wire.ts";
import { NavigateToCmd } from "./command.ts";
import { GotRailMessage, GotThreadMessage, ThreadChanged, type RootMessage } from "./message.ts";
import type { Model } from "./model.ts";

export type Commands = ReadonlyArray<Command.Command<RootMessage, never, Wire>>;
export type UpdateReturn = readonly [Model, Commands];

const none: Commands = [];

/** Delegate a rail message; the rail's OutMessage becomes navigation. */
const delegateToRail = (model: Model, railMessage: RailMsg.RailMessage): UpdateReturn => {
  const [nextRail, cmds, out] = Rail.update(model.rail, railMessage);
  const mapped = Command.mapMessages(cmds, (m) => GotRailMessage({ message: m }));
  return Option.match(out, {
    onNone: () => [evo(model, { rail: (_) => nextRail }), mapped],
    onSome: (out) => {
      // The rail surfaced a navigation fact; the root owns URLs. Deleting
      // the pinned thread leaves the route; opening one pushes its URL.
      const navigation =
        out._tag === "OpenedThread"
          ? [NavigateToCmd({ path: `/thread/${out.id}` })]
          : model.route._tag === "Thread" && model.route.id === out.id
            ? [NavigateToCmd({ path: "/" })]
            : [];
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
    onSome: (out) => {
      // The pane surfaced a navigation fact (a quick start opened a
      // thread); the root owns URLs.
      const navigation =
        out._tag === "OpenedThread" ? [NavigateToCmd({ path: `/thread/${out.id}` })] : [];
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
      route: (_) => route,
      rail: (_) => Rail.informRouteChanged(model.rail, route),
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
      Navigated: () => [model, none],
      NavigatedTo: () => [model, none],

      // A successful connect also clears the wire-error banner.
      Connected: (m) => {
        const result = connMachine.step(model.conn, m);
        return [
          evo(model, { conn: (_) => result.state, banner: (_) => null }),
          result._tag === "Transitioned" ? result.commands : none,
        ];
      },
      ConnectFailed: (m) => stepConn(model, m),
      ConnectionClosed: (m) => stepConn(model, m),
      RetryRequested: (m) => stepConn(model, m),

      GotRailMessage: ({ message: railMessage }) => delegateToRail(model, railMessage),
      GotThreadMessage: ({ message: threadMessage }) => delegateToThread(model, threadMessage),

      // A session event: route it to the pane only when the route pins its
      // thread (the pane never sees other threads' streams).
      WireEvent: ({ threadId, event }) =>
        model.route._tag === "Thread" && model.route.id === threadId
          ? delegateToThread(model, ThreadMsg.SessionEvent({ event }))
          : [model, none],
      // The registry broadcast: the rail upserts; the pane refreshes its
      // header info when the broadcast is its thread.
      ThreadChanged: ({ thread }) => {
        const [withRail, cmds] = delegateToRail(model, ThreadChanged({ thread }));
        if (model.thread.id !== thread.id) return [withRail, cmds];
        const [next, threadCmds] = delegateToThread(withRail, ThreadMsg.ThreadChanged({ thread }));
        return [next, [...cmds, ...threadCmds]];
      },

      ServerErrorNotice: ({ message }) => [evo(model, { banner: (_) => message }), none],
      DismissBanner: () => [evo(model, { banner: (_) => null }), none],
    }),
  );
