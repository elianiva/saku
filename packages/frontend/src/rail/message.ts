/**
 * The rail submodel's message union (rail/message.ts). These are internal
 * to the rail — the root sees them wrapped as `GotRailMessage`. The rail
 * surfaces the facts the root cares about (a thread was opened or deleted —
 * navigation) via an `OutMessage`, not through its Messages.
 */

import { Schema as S } from "effect";
import { Message } from "foldkit";
import { ThreadInfo, WireError } from "@saku/wire";

// ---- grid ----
/** A fresh list landed from the wire (a ListThreads result). */
export const ThreadsListed = Message.m("ThreadsListed", { threads: S.Array(ThreadInfo) });
export const ListFailed = Message.m("ListFailed", { error: WireError });
export const RefreshRequested = Message.m("RefreshRequested");
/** The registry broadcast: upsert into the list. */
export const ThreadChanged = Message.m("ThreadChanged", { thread: ThreadInfo });

// ---- delete ----
/** A rail row was clicked: the update emits `OpenedThread` for the root. */
export const ClickedThread = Message.m("ClickedThread", { id: S.String });
export const DeleteRequested = Message.m("DeleteRequested", { id: S.String });
export const ThreadDeleted = Message.m("ThreadDeleted", { id: S.String });
export const DeleteFailed = Message.m("DeleteFailed", { error: WireError });

export const RailMessage = S.Union([
  ThreadsListed,
  ListFailed,
  RefreshRequested,
  ThreadChanged,
  ClickedThread,
  DeleteRequested,
  ThreadDeleted,
  DeleteFailed,
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
