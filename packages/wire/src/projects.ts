/**
 * The wire's projects feature (CONTEXT.md: Project): the explicit list of
 * cwds whose pi sessions the user cares about — the scope of the session
 * window.
 *
 * A project is a scoping list entry, nothing more: it exists so the local
 * daemon lists only the pi sessions under the added projects instead of
 * scanning all of `~/.pi/agent/sessions`. Threads never reference projects
 * (a thread carries its own cwd); removing a project never touches adopted
 * threads.
 *
 * Pi session files live on the user's machine, and the project list exists
 * only to scope that window — so only the local daemon serves these
 * commands, the mirror of `list_pi_sessions` (the hub answers
 * `projects_not_served`).
 */

import { Schema as S } from "effect";

/**
 * One added project as the daemon sees it: the resolved absolute cwd and
 * when it was added. The display name is derived (the path's basename) —
 * the console never asks for one.
 */
export const ProjectInfo = S.Struct({
  addedAt: S.Number,
  /** The resolved absolute path of the added project. */
  path: S.String,
});
export type ProjectInfo = S.Schema.Type<typeof ProjectInfo>;

export const ListProjectsCommand = S.TaggedStruct("list_projects", {});
export const AddProjectCommand = S.TaggedStruct("add_project", {
  path: S.String,
});
export const RemoveProjectCommand = S.TaggedStruct("remove_project", {
  path: S.String,
});
/** Browse the add-project tree (CONTEXT.md: Add project): list one
 *  directory's subdirectories so the picker can be traversed level by
 *  level. `path` is the directory to list; "" opens the picker's default
 *  root (the deepest common ancestor of every cwd pi has sessions for,
 *  else the home directory). */
export const BrowseProjectDirsCommand = S.TaggedStruct("browse_project_dirs", {
  path: S.String,
});

export const ProjectCommand = S.Union([
  ListProjectsCommand,
  AddProjectCommand,
  RemoveProjectCommand,
  BrowseProjectDirsCommand,
]);
export type ProjectCommand = S.Schema.Type<typeof ProjectCommand>;

export const ListProjectsResponse = S.TaggedStruct("list_projects", {
  projects: S.Array(ProjectInfo),
});
export const AddProjectResponse = S.TaggedStruct("add_project", { project: ProjectInfo });
export const RemoveProjectResponse = S.TaggedStruct("remove_project", {});
/** One subdirectory of the browsed path (the tree's current level). */
export const ProjectDirEntry = S.Struct({
  /** True when pi has sessions for this exact cwd (the candidate marker). */
  hasPiSessions: S.Boolean,
  name: S.String,
  /** The resolved absolute path of the subdirectory. */
  path: S.String,
});
export type ProjectDirEntry = S.Schema.Type<typeof ProjectDirEntry>;
export const BrowseProjectDirsResponse = S.TaggedStruct("browse_project_dirs", {
  entries: S.Array(ProjectDirEntry),
  /** Its parent directory; null at the filesystem root (no up row). */
  parent: S.NullOr(S.String),
  /** The resolved directory that was listed. */
  path: S.String,
});
export type BrowseProjectDirsResult = S.Schema.Type<typeof BrowseProjectDirsResponse>;

export const ProjectResponse = S.Union([
  ListProjectsResponse,
  AddProjectResponse,
  RemoveProjectResponse,
  BrowseProjectDirsResponse,
]);
export type ProjectResponse = S.Schema.Type<typeof ProjectResponse>;
