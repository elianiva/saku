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
  entries: BrowseEntries.schema,
  /** Narrows the current level's rows by basename. */
  filter: S.String,
  /** The highlighted row within the visible rows. */
  highlight: S.Number,
  /** The listed directory's parent; null at the filesystem root. */
  parent: S.NullOr(S.String),
  /** The directory currently listed ("" until the first browse lands). */
  path: S.String,
});
export type PickerModel = S.Schema.Type<typeof PickerModel>;

export const initialPicker = (): PickerModel => ({
  entries: BrowseEntries.Idle(),
  filter: "",
  highlight: 0,
  parent: null,
  path: "",
});

export const Model = S.Struct({
  /** A pi adoption is in flight (guards double adoptions); null when clean. */
  adopting: S.NullOr(S.String),
  /** The add-project dialog (the foldkit Dialog submodel). */
  dialog: Dialog.Model,
  /** Expanded project paths; adding a project expands it. */
  expanded: S.Record(S.String, S.Boolean),
  list: ThreadList.schema,
  /** A transient banner message (e.g. a failed gesture); null when clean. */
  notice: S.NullOr(S.String),
  /** The dialog's tree state (the level being traversed). */
  picker: PickerModel,
  /** One lazy session list per project path (loaded on first expand). */
  projectSessions: S.Record(S.String, ProjectSessions.schema),
  /** The added projects (CONTEXT.md: Project) — the session window's scope. */
  projects: Projects.schema,
  /** An inline rename is in flight (the thread id + draft text). */
  renaming: S.NullOr(S.Struct({ id: S.String, value: S.String })),
  /** The route's pinned thread (the row highlight); null on the root route. */
  selectedId: S.NullOr(S.String),
  /** Per-project "show more" for the session preview. */
  sessionShowMore: S.Record(S.String, S.Boolean),
  /** The active thread list's preview "show more". */
  threadShowMore: S.Boolean,
  /** The rail's list: active threads + the projects window, or archived. */
  view: S.Literals(["active", "archived"]),
});
export type Model = S.Schema.Type<typeof Model>;

export const initialModel = (): Model => ({
  adopting: null,
  dialog: Dialog.init({ id: "project-picker" }),
  expanded: {},
  list: ThreadList.Idle(),
  notice: null,
  picker: initialPicker(),
  projectSessions: {},
  projects: Projects.Idle(),
  renaming: null,
  selectedId: null,
  sessionShowMore: {},
  threadShowMore: false,
  view: "active",
});
