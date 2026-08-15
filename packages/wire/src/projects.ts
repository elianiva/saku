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
  /** The resolved absolute path of the added project. */
  path: S.String,
  addedAt: S.Number,
});
export type ProjectInfo = S.Schema.Type<typeof ProjectInfo>;

export const ListProjectsCommand = S.TaggedStruct("list_projects", {});
export const AddProjectCommand = S.TaggedStruct("add_project", {
  path: S.String,
});
export const RemoveProjectCommand = S.TaggedStruct("remove_project", {
  path: S.String,
});
/** The picker's source (CONTEXT.md: Add project): every cwd pi has sessions
 *  for, decoded lossily from the session dir names (no file reads). */
export const ListProjectCandidatesCommand = S.TaggedStruct("list_project_candidates", {});

export const ProjectCommand = S.Union([
  ListProjectsCommand,
  AddProjectCommand,
  RemoveProjectCommand,
  ListProjectCandidatesCommand,
]);
export type ProjectCommand = S.Schema.Type<typeof ProjectCommand>;

export const ListProjectsResponse = S.TaggedStruct("list_projects", {
  projects: S.Array(ProjectInfo),
});
export const AddProjectResponse = S.TaggedStruct("add_project", { project: ProjectInfo });
export const RemoveProjectResponse = S.TaggedStruct("remove_project", {});
export const ListProjectCandidatesResponse = S.TaggedStruct("list_project_candidates", {
  candidates: S.Array(S.String),
});

export const ProjectResponse = S.Union([
  ListProjectsResponse,
  AddProjectResponse,
  RemoveProjectResponse,
  ListProjectCandidatesResponse,
]);
export type ProjectResponse = S.Schema.Type<typeof ProjectResponse>;
