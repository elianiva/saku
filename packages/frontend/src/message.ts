/**
 * The console's message union (message.ts): user intent (rail actions,
 * composer), command outcomes, and wire events bridged in from the
 * subscription.
 */

import { Schema as S } from "effect";
import { Message } from "foldkit";
import { HelloOk, ThreadInfo } from "@saku/wire";

import { EntryProjection, SessionEventProjection } from "./projection.ts";

// -- connection -------------------------------------------------------------

export const WireConnectRequested = Message.m("WireConnectRequested");
export const RetryRequested = Message.m("RetryRequested");
export const Connected = Message.m("Connected", { hello: HelloOk });
export const ConnectFailed = Message.m("ConnectFailed", { message: S.String });
export const ConnectionClosed = Message.m("ConnectionClosed");

// -- rail -------------------------------------------------------------------

export const ThreadsListed = Message.m("ThreadsListed", { threads: S.Array(ThreadInfo) });
export const ThreadsFailed = Message.m("ThreadsFailed", { message: S.String });
export const RefreshRequested = Message.m("RefreshRequested");
export const RailInputChanged = Message.m("RailInputChanged", { text: S.String });
export const QuickStartRequested = Message.m("QuickStartRequested");
export const ThreadCreated = Message.m("ThreadCreated", { thread: ThreadInfo });
export const CreateFailed = Message.m("CreateFailed", { message: S.String });
export const DeleteRequested = Message.m("DeleteRequested", { id: S.String });
export const ThreadDeleted = Message.m("ThreadDeleted", { id: S.String });
export const DeleteFailed = Message.m("DeleteFailed", { message: S.String });

// -- the active thread ------------------------------------------------------

export const SelectRequested = Message.m("SelectRequested", { id: S.String });
export const TrailLoaded = Message.m("TrailLoaded", {
  id: S.String,
  entries: S.Array(EntryProjection),
  tailSeq: S.Number,
});
export const TrailFailed = Message.m("TrailFailed", { message: S.String });

// -- composer ---------------------------------------------------------------

export const ComposerChanged = Message.m("ComposerChanged", { text: S.String });
export const SendRequested = Message.m("SendRequested");
export const PromptAcked = Message.m("PromptAcked");
export const SendFailed = Message.m("SendFailed", { message: S.String });
export const AbortRequested = Message.m("AbortRequested");
export const AbortDone = Message.m("AbortDone");

// -- wire events (subscription → update) ------------------------------------

export const WireEvent = Message.m("WireEvent", {
  threadId: S.String,
  event: SessionEventProjection,
});
export const ThreadChanged = Message.m("ThreadChanged", { thread: ThreadInfo });
export const ServerErrorNotice = Message.m("ServerErrorNotice", { message: S.String });

// -- housekeeping -----------------------------------------------------------

/** Scroll the trail (fired after appends; the command checks near-bottom). */
export const ScrollTrail = Message.m("ScrollTrail");
export const ScrollDone = Message.m("ScrollDone");
export const DismissBanner = Message.m("DismissBanner");

export const AppMessage = S.Union([
  WireConnectRequested,
  RetryRequested,
  Connected,
  ConnectFailed,
  ConnectionClosed,
  ThreadsListed,
  ThreadsFailed,
  RefreshRequested,
  RailInputChanged,
  QuickStartRequested,
  ThreadCreated,
  CreateFailed,
  DeleteRequested,
  ThreadDeleted,
  DeleteFailed,
  SelectRequested,
  TrailLoaded,
  TrailFailed,
  ComposerChanged,
  SendRequested,
  PromptAcked,
  SendFailed,
  AbortRequested,
  AbortDone,
  WireEvent,
  ThreadChanged,
  ServerErrorNotice,
  ScrollTrail,
  ScrollDone,
  DismissBanner,
]);
export type AppMessage = S.Schema.Type<typeof AppMessage>;
