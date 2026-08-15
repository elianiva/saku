/**
 * The rail submodel's commands (rail/command.ts): the wire operations as
 * foldkit Commands landing rail messages. View-side gestures that need no
 * wire (expand/collapse, view switches, draft edits) are plain messages —
 * only effects ride Commands. Errors never escape as defects — every
 * command body fails only with `WireError` and catches the tag itself,
 * projecting it into a `*Failed` message so the rail can show it. The
 * quick-start command moved to the pane with the gesture
 * (thread/command.ts).
 */

import { Effect, Schema as S } from "effect";
import { Command } from "foldkit";

import { Wire } from "../wire.ts";
import {
  ArchiveFailed,
  DeleteFailed,
  ListFailed,
  PiSessionAdoptFailed,
  PiSessionAdopted,
  PickerBrowseFailed,
  PickerBrowseListed,
  ProjectAddFailed,
  ProjectAdded,
  ProjectRemoveFailed,
  ProjectRemoved,
  ProjectSessionsListFailed,
  ProjectSessionsListed,
  ProjectsListFailed,
  ProjectsListed,
  ThreadArchived,
  ThreadDeleted,
  ThreadRenamed,
  ThreadRenameFailed,
  ThreadUnarchived,
  ThreadsListed,
  UnarchiveFailed,
} from "./message.ts";

/** List the registry (the rail's grid). */
export const ListThreadsCmd = Command.define("ListThreads", {
  messages: [ThreadsListed, ListFailed],
  execute: Effect.gen(function* () {
    const { client } = yield* Wire;
    const threads = yield* client.listThreads();
    return ThreadsListed({ threads });
  }).pipe(Effect.catchTag("WireError", (error) => Effect.succeed(ListFailed({ error })))),
});

/** List the added projects (the window's scope; CONTEXT.md: Project). */
export const ListProjectsCmd = Command.define("ListProjects", {
  messages: [ProjectsListed, ProjectsListFailed],
  execute: Effect.gen(function* () {
    const { client } = yield* Wire;
    const projects = yield* client.listProjects();
    return ProjectsListed({ projects });
  }).pipe(Effect.catchTag("WireError", (error) => Effect.succeed(ProjectsListFailed({ error })))),
});

/** Add a project by path (the explicit gesture; re-adding is a no-op). */
export const AddProjectCmd = Command.define("AddProject", {
  args: { path: S.String },
  messages: [ProjectAdded, ProjectAddFailed],
  execute: ({ path }) =>
    Effect.gen(function* () {
      const { client } = yield* Wire;
      const project = yield* client.addProject(path);
      return ProjectAdded({ project });
    }).pipe(Effect.catchTag("WireError", (error) => Effect.succeed(ProjectAddFailed({ error })))),
});

/** Remove a project from the window; adopted threads are untouched. */
export const RemoveProjectCmd = Command.define("RemoveProject", {
  args: { path: S.String },
  messages: [ProjectRemoved, ProjectRemoveFailed],
  execute: ({ path }) =>
    Effect.gen(function* () {
      const { client } = yield* Wire;
      yield* client.removeProject(path);
      return ProjectRemoved({ path });
    }).pipe(
      Effect.catchTag("WireError", (error) => Effect.succeed(ProjectRemoveFailed({ error }))),
    ),
});

/** One project's sessions — lazy, fired on first expand (never at connect). */
export const ListProjectSessionsCmd = Command.define("ListProjectSessions", {
  args: { path: S.String },
  messages: [ProjectSessionsListed, ProjectSessionsListFailed],
  execute: ({ path }) =>
    Effect.gen(function* () {
      const { client } = yield* Wire;
      const sessions = yield* client.listPiSessions(path);
      return ProjectSessionsListed({ path, sessions });
    }).pipe(
      Effect.catchTag("WireError", (error) =>
        Effect.succeed(ProjectSessionsListFailed({ path, error })),
      ),
    ),
});

/** One level of the add-project tree (CONTEXT.md: Add project): the
 *  subdirectories of `path` — "" opens the picker's default root (the
 *  deepest common ancestor of every cwd pi has sessions for). */
export const BrowseProjectDirsCmd = Command.define("BrowseProjectDirs", {
  args: { path: S.String },
  messages: [PickerBrowseListed, PickerBrowseFailed],
  execute: ({ path }) =>
    Effect.gen(function* () {
      const { client } = yield* Wire;
      const browse = yield* client.browseProjectDirs(path);
      return PickerBrowseListed({
        path: browse.path,
        parent: browse.parent,
        entries: browse.entries,
      });
    }).pipe(Effect.catchTag("WireError", (error) => Effect.succeed(PickerBrowseFailed({ error })))),
});

/** Archive a thread: visibility-only (CONTEXT.md: Archive). */
export const ArchiveThreadCmd = Command.define("ArchiveThread", {
  args: { id: S.String },
  messages: [ThreadArchived, ArchiveFailed],
  execute: ({ id }) =>
    Effect.gen(function* () {
      const { client } = yield* Wire;
      const thread = yield* client.archiveThread(id);
      return ThreadArchived({ thread });
    }).pipe(Effect.catchTag("WireError", (error) => Effect.succeed(ArchiveFailed({ error })))),
});

/** Unarchive a thread: back to the active list. */
export const UnarchiveThreadCmd = Command.define("UnarchiveThread", {
  args: { id: S.String },
  messages: [ThreadUnarchived, UnarchiveFailed],
  execute: ({ id }) =>
    Effect.gen(function* () {
      const { client } = yield* Wire;
      const thread = yield* client.unarchiveThread(id);
      return ThreadUnarchived({ thread });
    }).pipe(Effect.catchTag("WireError", (error) => Effect.succeed(UnarchiveFailed({ error })))),
});

/** Rename a thread (a user rename wins over auto-title forever). */
export const RenameThreadCmd = Command.define("RenameThread", {
  args: { id: S.String, name: S.String },
  messages: [ThreadRenamed, ThreadRenameFailed],
  execute: ({ id, name }) =>
    Effect.gen(function* () {
      const { client } = yield* Wire;
      const thread = yield* client.renameThread(id, name);
      return ThreadRenamed({ thread });
    }).pipe(Effect.catchTag("WireError", (error) => Effect.succeed(ThreadRenameFailed({ error })))),
});

/** Adopt a pi session as a thread (adoption, not a bridge — the pi file is
 *  never written; the thread's trail is saku's own). */
export const AdoptPiSessionCmd = Command.define("AdoptPiSession", {
  args: { path: S.String },
  messages: [PiSessionAdopted, PiSessionAdoptFailed],
  execute: ({ path }) =>
    Effect.gen(function* () {
      const { client } = yield* Wire;
      const thread = yield* client.importPiSession(path);
      return PiSessionAdopted({ thread });
    }).pipe(
      Effect.catchTag("WireError", (error) => Effect.succeed(PiSessionAdoptFailed({ error }))),
    ),
});

/** Delete a thread (registry record + worker storage). */
export const DeleteThreadCmd = Command.define("DeleteThread", {
  args: { id: S.String },
  messages: [ThreadDeleted, DeleteFailed],
  execute: ({ id }) =>
    Effect.gen(function* () {
      const { client } = yield* Wire;
      yield* client.deleteThread(id);
      return ThreadDeleted({ id });
    }).pipe(Effect.catchTag("WireError", (error) => Effect.succeed(DeleteFailed({ error })))),
});
