/**
 * The rail submodel's Model (rail/model.ts): the registry list as AsyncData
 * (Idle → Success/Failure), the route-derived selection highlight, and a
 * transient notice for failed gestures. The list holds EVERY thread
 * (active and archived); the view filters by `archivedAt` (presentation.ts)
 * — upserts stay simple, the views derive. The pi-session window
 * (CONTEXT.md: Pi sessions, Project) rides alongside: the added projects as
 * AsyncData, one lazy session list per project path (loaded on first
 * expand — never at connect), per-project expand/show-more state, and the
 * add-project picker — a modal dialog (the foldkit Dialog submodel) whose
 * tree state (the level being traversed) is the rail's own.
 */

import { Schema as S } from "effect";
import { AsyncData } from "foldkit";
import * as Dialog from "@foldkit/ui/dialog";
import { PiSessionInfo, ProjectDirEntry, ProjectInfo, ThreadInfo, WireError } from "@saku/wire";

/** The registry list `listThreads()` returns, held as AsyncData. */
export const ThreadList = AsyncData.Schema(S.Array(ThreadInfo), WireError);
export const threadList = ThreadList;

/** The added projects `listProjects()` returns, held as AsyncData. */
export const Projects = AsyncData.Schema(S.Array(ProjectInfo), WireError);
export const projects = Projects;

/** One project's session list `listPiSessions(path)` returns, as AsyncData. */
export const ProjectSessions = AsyncData.Schema(S.Array(PiSessionInfo), WireError);
export const projectSessions = ProjectSessions;

/** One browse level's entries `browseProjectDirs(path)` returns (the
 *  add-project tree's current level), as AsyncData. */
export const BrowseEntries = AsyncData.Schema(S.Array(ProjectDirEntry), WireError);
export const browseEntries = BrowseEntries;

/** The add-project picker's tree state: the level being listed, its parent
 *  (the up row), the filter narrowing the rows, and the highlighted row
 *  (an index into the visible rows: up row first, then the filtered dirs).
 *  The dialog shell itself is the foldkit Dialog submodel. */
export const PickerModel = S.Struct({
  /** The directory currently listed ("" until the first browse lands). */
  path: S.String,
  /** The listed directory's parent; null at the filesystem root. */
  parent: S.NullOr(S.String),
  entries: BrowseEntries.schema,
  /** Narrows the current level's rows by basename. */
  filter: S.String,
  /** The highlighted row within the visible rows. */
  highlight: S.Number,
});
export type PickerModel = S.Schema.Type<typeof PickerModel>;

export const initialPicker = (): PickerModel => ({
  path: "",
  parent: null,
  entries: BrowseEntries.Idle(),
  filter: "",
  highlight: 0,
});

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
  /** The add-project dialog (the foldkit Dialog submodel). */
  dialog: Dialog.Model,
  /** The dialog's tree state (the level being traversed). */
  picker: PickerModel,
  /** A pi adoption is in flight (guards double adoptions); null when clean. */
  adopting: S.NullOr(S.String),
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
  dialog: Dialog.init({ id: "project-picker" }),
  picker: initialPicker(),
  adopting: null,
  renaming: null,
});
