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
import { PiSessionInfo, ProjectInfo, ThreadInfo, WireError } from "@saku/wire";

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

/** Archive gestures (CONTEXT.md: Archive): visibility-only, reversible. */
export const ArchiveRequested = Message.m("ArchiveRequested", { id: S.String });
export const ThreadArchived = Message.m("ThreadArchived", { thread: ThreadInfo });
export const ArchiveFailed = Message.m("ArchiveFailed", { error: WireError });
export const UnarchiveRequested = Message.m("UnarchiveRequested", { id: S.String });
export const ThreadUnarchived = Message.m("ThreadUnarchived", { thread: ThreadInfo });
export const UnarchiveFailed = Message.m("UnarchiveFailed", { error: WireError });

/** Inline rename (double-click the title): draft → commit → landing. */
export const ThreadRenameRequested = Message.m("ThreadRenameRequested", { id: S.String });
export const ThreadRenameDraftChanged = Message.m("ThreadRenameDraftChanged", {
  text: S.String,
});
export const ThreadRenameCommitted = Message.m("ThreadRenameCommitted");
export const ThreadRenameCancelled = Message.m("ThreadRenameCancelled");
export const ThreadRenamed = Message.m("ThreadRenamed", { thread: ThreadInfo });
export const ThreadRenameFailed = Message.m("ThreadRenameFailed", { error: WireError });

/** The projects window (CONTEXT.md: Project, Pi sessions). */
export const ProjectsListed = Message.m("ProjectsListed", { projects: S.Array(ProjectInfo) });
export const ProjectsListFailed = Message.m("ProjectsListFailed", { error: WireError });
export const ProjectAdded = Message.m("ProjectAdded", { project: ProjectInfo });
export const ProjectAddFailed = Message.m("ProjectAddFailed", { error: WireError });
export const ProjectRemoved = Message.m("ProjectRemoved", { path: S.String });
export const ProjectRemoveFailed = Message.m("ProjectRemoveFailed", { error: WireError });
/** One project's session list landed (lazy — fetched on first expand). */
export const ProjectSessionsListed = Message.m("ProjectSessionsListed", {
  path: S.String,
  sessions: S.Array(PiSessionInfo),
});
export const ProjectSessionsListFailed = Message.m("ProjectSessionsListFailed", {
  path: S.String,
  error: WireError,
});

export const ProjectExpanded = Message.m("ProjectExpanded", { path: S.String });
export const ProjectCollapsed = Message.m("ProjectCollapsed", { path: S.String });
export const ProjectShowMore = Message.m("ProjectShowMore", { path: S.String });
export const ProjectShowLess = Message.m("ProjectShowLess", { path: S.String });
export const ThreadShowMore = Message.m("ThreadShowMore");
export const ThreadShowLess = Message.m("ThreadShowLess");

/** The rail's view: active (threads + projects window) or archived. */
export const ArchivedViewRequested = Message.m("ArchivedViewRequested");
export const ActiveViewRequested = Message.m("ActiveViewRequested");

/** The add-project gesture: open the input, draft it, commit it. */
export const AddProjectRequested = Message.m("AddProjectRequested");
export const AddProjectDraftChanged = Message.m("AddProjectDraftChanged", { text: S.String });
export const AddProjectCommitted = Message.m("AddProjectCommitted");
export const AddProjectCancelled = Message.m("AddProjectCancelled");
/** The picker's candidates landed (every cwd pi has sessions for). */
export const ProjectCandidatesListed = Message.m("ProjectCandidatesListed", {
  candidates: S.Array(S.String),
});
export const ProjectCandidatesListFailed = Message.m("ProjectCandidatesListFailed", {
  error: WireError,
});
export const RemoveProjectRequested = Message.m("RemoveProjectRequested", { path: S.String });

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
  ArchiveRequested,
  ThreadArchived,
  ArchiveFailed,
  UnarchiveRequested,
  ThreadUnarchived,
  UnarchiveFailed,
  ThreadRenameRequested,
  ThreadRenameDraftChanged,
  ThreadRenameCommitted,
  ThreadRenameCancelled,
  ThreadRenamed,
  ThreadRenameFailed,
  ProjectsListed,
  ProjectsListFailed,
  ProjectAdded,
  ProjectAddFailed,
  ProjectRemoved,
  ProjectRemoveFailed,
  ProjectSessionsListed,
  ProjectSessionsListFailed,
  ProjectExpanded,
  ProjectCollapsed,
  ProjectShowMore,
  ProjectShowLess,
  ThreadShowMore,
  ThreadShowLess,
  ArchivedViewRequested,
  ActiveViewRequested,
  AddProjectRequested,
  AddProjectDraftChanged,
  AddProjectCommitted,
  AddProjectCancelled,
  ProjectCandidatesListed,
  ProjectCandidatesListFailed,
  RemoveProjectRequested,
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
