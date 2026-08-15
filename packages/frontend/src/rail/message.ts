/**
 * The rail submodel's message union (rail/message.ts). These are internal
 * to the rail — the root sees them wrapped as `GotRailMessage`. The rail
 * surfaces the facts the root cares about (a thread was opened or deleted —
 * navigation) via an `OutMessage`, not through its Messages. A pi adoption
 * surfaces as `OpenedThread` too: opening an adopted session is exactly a
 * thread click (the root pushes its URL).
 */

import { Schema as S } from "effect";
import { Message } from "foldkit";
import { PiSessionInfo, ThreadInfo, WireError } from "@saku/wire";

/** A fresh list landed from the wire (a ListThreads result). */
export const ThreadsListed = Message.m("ThreadsListed", { threads: S.Array(ThreadInfo) });
export const ListFailed = Message.m("ListFailed", { error: WireError });
export const RefreshRequested = Message.m("RefreshRequested");
/** The registry broadcast: upsert into the list. */
export const ThreadChanged = Message.m("ThreadChanged", { thread: ThreadInfo });

/** A rail row was clicked: the update emits `OpenedThread` for the root. */
export const ClickedThread = Message.m("ClickedThread", { id: S.String });
export const DeleteRequested = Message.m("DeleteRequested", { id: S.String });
export const ThreadDeleted = Message.m("ThreadDeleted", { id: S.String });
export const DeleteFailed = Message.m("DeleteFailed", { error: WireError });

/** The local daemon's answer: pi's sessions on this machine. */
export const PiSessionsListed = Message.m("PiSessionsListed", {
  sessions: S.Array(PiSessionInfo),
});
export const PiSessionsListFailed = Message.m("PiSessionsListFailed", { error: WireError });
/** A pi session row was clicked: adopt it as a thread, then open it. */
export const PiSessionClicked = Message.m("PiSessionClicked", { path: S.String });
/** The adoption landed: a thread was born from the pi session. */
export const PiSessionAdopted = Message.m("PiSessionAdopted", { thread: ThreadInfo });
export const PiSessionAdoptFailed = Message.m("PiSessionAdoptFailed", { error: WireError });

export const RailMessage = S.Union([
  ThreadsListed,
  ListFailed,
  RefreshRequested,
  ThreadChanged,
  ClickedThread,
  DeleteRequested,
  ThreadDeleted,
  DeleteFailed,
  PiSessionsListed,
  PiSessionsListFailed,
  PiSessionClicked,
  PiSessionAdopted,
  PiSessionAdoptFailed,
]);
export type RailMessage = S.Schema.Type<typeof RailMessage>;

/**
 * The facts the rail surfaces to the root (the informing convention, ADR
 * 0009). Narrow and semantic: the root owns navigation, so "open this
 * thread" and "this thread was deleted" are the two facts the rail emits.
 * The root reacts by pushing the `/thread/:id` URL (or leaving `/` when the
 * deleted thread was the pinned one). `OpenedThread` is the root's own
 * message now — both the rail (a row click) and the pane (a quick start)
 * surface the same fact.
 */
import type { OpenedThread } from "../root/message.ts";
export const DeletedThread = Message.m("DeletedThread", { id: S.String });
export type RailOutMessage = typeof OpenedThread.Type | typeof DeletedThread.Type;
