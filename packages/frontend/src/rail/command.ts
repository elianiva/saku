/**
 * The rail submodel's commands (rail/command.ts): the wire operations as
 * foldkit Commands landing rail messages. View-side gestures that need no
 * wire (expand/collapse, view switches, draft edits) are plain messages —
 * only effects ride Commands. Errors never escape as defects — every
 * command body fails only with `WireError`, and the shared `catchWireError`
 * (root/command.ts) projects it into a `*Failed` message so the rail can
 * show it. The quick-start command moved to the pane with the gesture
 * (thread/command.ts).
 */

import { Effect, Schema as S } from "effect";
import { Command } from "foldkit";

import { catchWireError } from "../root/command.ts";
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
  execute: catchWireError(
    Effect.gen(function* () {
      const { client } = yield* Wire;
      const threads = yield* client.listThreads();
      return ThreadsListed({ threads });
    }),
    (error) => ListFailed({ error }),
  ),
});

/** List the added projects (the window's scope; CONTEXT.md: Project). */
export const ListProjectsCmd = Command.define("ListProjects", {
  messages: [ProjectsListed, ProjectsListFailed],
  execute: catchWireError(
    Effect.gen(function* () {
      const { client } = yield* Wire;
      const projects = yield* client.listProjects();
      return ProjectsListed({ projects });
    }),
    (error) => ProjectsListFailed({ error }),
  ),
});

/** Add a project by path (the explicit gesture; re-adding is a no-op). */
export const AddProjectCmd = Command.define("AddProject", {
  args: { path: S.String },
  messages: [ProjectAdded, ProjectAddFailed],
  execute: ({ path }) =>
    catchWireError(
      Effect.gen(function* () {
        const { client } = yield* Wire;
        const project = yield* client.addProject(path);
        return ProjectAdded({ project });
      }),
      (error) => ProjectAddFailed({ error }),
    ),
});

/** Remove a project from the window; adopted threads are untouched. */
export const RemoveProjectCmd = Command.define("RemoveProject", {
  args: { path: S.String },
  messages: [ProjectRemoved, ProjectRemoveFailed],
  execute: ({ path }) =>
    catchWireError(
      Effect.gen(function* () {
        const { client } = yield* Wire;
        yield* client.removeProject(path);
        return ProjectRemoved({ path });
      }),
      (error) => ProjectRemoveFailed({ error }),
    ),
});

/** One project's sessions — lazy, fired on first expand (never at connect). */
export const ListProjectSessionsCmd = Command.define("ListProjectSessions", {
  args: { path: S.String },
  messages: [ProjectSessionsListed, ProjectSessionsListFailed],
  execute: ({ path }) =>
    catchWireError(
      Effect.gen(function* () {
        const { client } = yield* Wire;
        const sessions = yield* client.listPiSessions(path);
        return ProjectSessionsListed({ path, sessions });
      }),
      (error) => ProjectSessionsListFailed({ path, error }),
    ),
});

/** One level of the add-project tree (CONTEXT.md: Add project): the
 *  subdirectories of `path` — "" opens the picker's default root (the
 *  deepest common ancestor of every cwd pi has sessions for). */
export const BrowseProjectDirsCmd = Command.define("BrowseProjectDirs", {
  args: { path: S.String },
  messages: [PickerBrowseListed, PickerBrowseFailed],
  execute: ({ path }) =>
    catchWireError(
      Effect.gen(function* () {
        const { client } = yield* Wire;
        const browse = yield* client.browseProjectDirs(path);
        return PickerBrowseListed({
          path: browse.path,
          parent: browse.parent,
          entries: browse.entries,
        });
      }),
      (error) => PickerBrowseFailed({ error }),
    ),
});

/** Archive a thread: visibility-only (CONTEXT.md: Archive). */
export const ArchiveThreadCmd = Command.define("ArchiveThread", {
  args: { id: S.String },
  messages: [ThreadArchived, ArchiveFailed],
  execute: ({ id }) =>
    catchWireError(
      Effect.gen(function* () {
        const { client } = yield* Wire;
        const thread = yield* client.archiveThread(id);
        return ThreadArchived({ thread });
      }),
      (error) => ArchiveFailed({ error }),
    ),
});

/** Unarchive a thread: back to the active list. */
export const UnarchiveThreadCmd = Command.define("UnarchiveThread", {
  args: { id: S.String },
  messages: [ThreadUnarchived, UnarchiveFailed],
  execute: ({ id }) =>
    catchWireError(
      Effect.gen(function* () {
        const { client } = yield* Wire;
        const thread = yield* client.unarchiveThread(id);
        return ThreadUnarchived({ thread });
      }),
      (error) => UnarchiveFailed({ error }),
    ),
});

/** Rename a thread (a user rename wins over auto-title forever). */
export const RenameThreadCmd = Command.define("RenameThread", {
  args: { id: S.String, name: S.String },
  messages: [ThreadRenamed, ThreadRenameFailed],
  execute: ({ id, name }) =>
    catchWireError(
      Effect.gen(function* () {
        const { client } = yield* Wire;
        const thread = yield* client.renameThread(id, name);
        return ThreadRenamed({ thread });
      }),
      (error) => ThreadRenameFailed({ error }),
    ),
});

/** Adopt a pi session as a thread (adoption, not a bridge — the pi file is
 *  never written; the thread's trail is saku's own). */
export const AdoptPiSessionCmd = Command.define("AdoptPiSession", {
  args: { path: S.String },
  messages: [PiSessionAdopted, PiSessionAdoptFailed],
  execute: ({ path }) =>
    catchWireError(
      Effect.gen(function* () {
        const { client } = yield* Wire;
        const thread = yield* client.importPiSession(path);
        return PiSessionAdopted({ thread });
      }),
      (error) => PiSessionAdoptFailed({ error }),
    ),
});

/** Delete a thread (registry record + worker storage). */
export const DeleteThreadCmd = Command.define("DeleteThread", {
  args: { id: S.String },
  messages: [ThreadDeleted, DeleteFailed],
  execute: ({ id }) =>
    catchWireError(
      Effect.gen(function* () {
        const { client } = yield* Wire;
        yield* client.deleteThread(id);
        return ThreadDeleted({ id });
      }),
      (error) => DeleteFailed({ error }),
    ),
});
