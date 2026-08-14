/**
 * The rail submodel's update loop (rail/update.ts): pure state transitions
 * returning the `[Model, Commands, Option<OutMessage>]` 3-tuple — the
 * OutMessage is how the rail tells the root "open this thread" / "this
 * thread was deleted" (the root owns navigation). Most arms emit
 * `Option.none()`.
 *
 * `informRouteChanged` is the parent's hook for a route change: the rail is
 * always visible, so the only route-derived field is the row highlight.
 */

import { Match as M, Option } from "effect";
import { Command } from "foldkit";
import { evo } from "foldkit/struct";
import type { ThreadInfo } from "@saku/wire";

import type { AppRoute } from "../route.ts";
import { OpenedThread } from "../root/message.ts";
import { Wire } from "../wire.ts";
import { DeleteThreadCmd, ListThreadsCmd } from "./command.ts";
import { DeletedThread, type RailMessage, type RailOutMessage } from "./message.ts";
import { Model, threadList } from "./model.ts";

export type Commands = ReadonlyArray<Command.Command<RailMessage, never, Wire>>;
export type UpdateReturn = readonly [Model, Commands, Option.Option<RailOutMessage>];

const none: Commands = [];

/** Upsert a thread into the list (broadcast order is registry order). */
const upsertThread = (model: Model, thread: ThreadInfo) => {
  if (model.list._tag !== "Success") return model;
  const threads = model.list.data.some((existing) => existing.id === thread.id)
    ? model.list.data.map((existing) => (existing.id === thread.id ? thread : existing))
    : [...model.list.data, thread];
  return evo(model, { list: (_) => threadList.Success({ data: threads }) });
};

/** Drop a thread from the list. */
const removeThread = (model: Model, id: string) => {
  if (model.list._tag !== "Success") return model;
  const threads = model.list.data.filter((thread) => thread.id !== id);
  return evo(model, { list: (_) => threadList.Success({ data: threads }) });
};

export const update = (model: Model, message: RailMessage) =>
  M.value(message).pipe(
    M.withReturnType<UpdateReturn>(),
    M.tagsExhaustive({
      ThreadsListed: ({ threads }) => [
        evo(model, { list: (_) => threadList.Success({ data: threads }), notice: (_) => null }),
        none,
        Option.none(),
      ],
      ListFailed: ({ error }) => [
        evo(model, { list: (_) => threadList.Failure({ error }) }),
        none,
        Option.none(),
      ],
      RefreshRequested: () => [model, [ListThreadsCmd()], Option.none()],
      // The registry broadcast: keep the list current (a thread's state,
      // env, or name changed — the auto-title lands here).
      ThreadChanged: ({ thread }) => [upsertThread(model, thread), none, Option.none()],

      // A row clicked: surface the fact upward and let the root navigate.
      ClickedThread: ({ id }) => [model, none, Option.some(OpenedThread({ id }))],
      DeleteRequested: ({ id }) => [model, [DeleteThreadCmd({ id })], Option.none()],
      // Deleted: surface the fact — the root leaves `/thread/:id` when the
      // deleted thread was the pinned one.
      ThreadDeleted: ({ id }) => [
        removeThread(model, id),
        none,
        Option.some(DeletedThread({ id })),
      ],
      DeleteFailed: ({ error }) => [
        evo(model, { notice: (_) => error.message }),
        none,
        Option.none(),
      ],
    }),
  );

/** The root's hook for a route change: the rail's only route-derived field
 *  is the selection highlight (the pinned thread's id). */
export const informRouteChanged = (model: Model, route: AppRoute) =>
  evo(model, { selectedId: (_) => (route._tag === "Thread" ? route.id : null) });
