/**
 * The rail submodel's Model (rail/model.ts): the registry list as AsyncData
 * (Idle → Success/Failure), the route-derived selection highlight, and a
 * transient notice for failed gestures. The list holds EVERY thread
 * (active and archived); the view filters by `archivedAt` (presentation.ts)
 * — upserts stay simple, the views derive. The pi-session window
 * (CONTEXT.md: Pi sessions, Project) rides alongside: the added projects as
 * AsyncData, one lazy session list per project path (loaded on first
 * expand — never at connect), per-project expand/show-more state, and the
 * add-project/rename inline-input drafts.
 */

import { Schema as S } from "effect";
import { AsyncData } from "foldkit";
import { PiSessionInfo, ProjectInfo, ThreadInfo, WireError } from "@saku/wire";

/** The registry list `listThreads()` returns, held as AsyncData. */
export const ThreadList = AsyncData.Schema(S.Array(ThreadInfo), WireError);
export const threadList = ThreadList;

/** The added projects `listProjects()` returns, held as AsyncData. */
export const Projects = AsyncData.Schema(S.Array(ProjectInfo), WireError);
export const projects = Projects;

/** One project's session list `listPiSessions(path)` returns, as AsyncData. */
export const ProjectSessions = AsyncData.Schema(S.Array(PiSessionInfo), WireError);
export const projectSessions = ProjectSessions;

/** The add-project picker's source (CONTEXT.md: Add project): every cwd pi
 *  has sessions for, as AsyncData (fetched when the input opens). */
export const ProjectCandidates = AsyncData.Schema(S.Array(S.String), WireError);
export const projectCandidates = ProjectCandidates;

export const Model = S.Struct({
  list: ThreadList.schema,
  /** The route's pinned thread (the row highlight); null on the root route. */
  selectedId: S.NullOr(S.String),
  /** A transient banner message (e.g. a failed gesture); null when clean. */
  notice: S.NullOr(S.String),
  /** The added projects (CONTEXT.md: Project) — the session window's scope. */
  projects: Projects.schema,
  /** One lazy session list per project path (loaded on first expand). */
  projectSessions: S.Record(S.String, ProjectSessions.schema),
  /** Expanded project paths; adding a project expands it. */
  expanded: S.Record(S.String, S.Boolean),
  /** Per-project "show more" for the session preview. */
  sessionShowMore: S.Record(S.String, S.Boolean),
  /** The active thread list's preview "show more". */
  threadShowMore: S.Boolean,
  /** The rail's list: active threads + the projects window, or archived. */
  view: S.Literals(["active", "archived"]),
  /** A pi adoption is in flight (guards double adoptions); null when clean. */
  adopting: S.NullOr(S.String),
  /** The add-project input is open (CONTEXT.md: Add project). */
  adding: S.Boolean,
  addDraft: S.String,
  /** The picker's candidates while the add-project input is open. */
  candidates: ProjectCandidates.schema,
  /** An inline rename is in flight (the thread id + draft text). */
  renaming: S.NullOr(S.Struct({ id: S.String, value: S.String })),
});
export type Model = S.Schema.Type<typeof Model>;

export const initialModel = (): Model => ({
  list: ThreadList.Idle(),
  selectedId: null,
  notice: null,
  projects: Projects.Idle(),
  projectSessions: {},
  expanded: {},
  sessionShowMore: {},
  threadShowMore: false,
  view: "active",
  adopting: null,
  adding: false,
  addDraft: "",
  candidates: ProjectCandidates.Idle(),
  renaming: null,
});
