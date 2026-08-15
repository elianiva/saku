/**
 * The rail submodel's update loop (rail/update.ts): pure state transitions
 * returning the `[Model, Commands, Option<OutMessage>]` 3-tuple — the
 * OutMessage is how the rail tells the root "open this thread" / "this
 * thread was deleted" (the root owns navigation). Most arms emit
 * `Option.none()`.
 *
 * `informRouteChanged` is the parent's hook for a route change: the rail is
 * always visible, so the only route-derived field is the row highlight.
 *
 * The rail also owns the project window (CONTEXT.md: Project, Pi sessions):
 * connect re-lists the registry and the added projects only — a project's
 * sessions are lazy (fetched on first expand, cached), so startup never
 * reads pi session files. A session row click adopts it — the adoption
 * landing upserts the born thread and surfaces `OpenedThread`, exactly like
 * a thread row click. Archive moves a thread between the active and
 * archived views (both derive from one list via `archivedAt`).
 */

import { Match as M, Option } from "effect";
import { Command } from "foldkit";
import * as Dialog from "@foldkit/ui/dialog";
import { evo } from "foldkit/struct";
import type { ProjectInfo, ThreadInfo } from "@saku/wire";

import type { AppRoute } from "../route.ts";
import { OpenedThread } from "../root/message.ts";
import { pickerRows } from "../presentation.ts";
import { Wire } from "../wire.ts";
import {
  AdoptPiSessionCmd,
  AddProjectCmd,
  ArchiveThreadCmd,
  BrowseProjectDirsCmd,
  DeleteThreadCmd,
  ListProjectSessionsCmd,
  ListProjectsCmd,
  ListThreadsCmd,
  RemoveProjectCmd,
  RenameThreadCmd,
  UnarchiveThreadCmd,
} from "./command.ts";
import {
  DeletedThread,
  GotPickerDialogMessage,
  PickerAddRequested,
  PickerBrowseFailed,
  PickerBrowseListed,
  PickerDirChosen,
  PickerFilterChanged,
  PickerHighlightMoved,
  PickerUpRequested,
  type RailMessage,
  type RailOutMessage,
} from "./message.ts";
import {
  browseEntries,
  initialPicker,
  Model,
  projectSessions,
  projects,
  threadList,
} from "./model.ts";

export type Commands = ReadonlyArray<Command.Command<RailMessage, never, Wire>>;
export type UpdateReturn = readonly [Model, Commands, Option.Option<RailOutMessage>];

const none: Commands = [];

/** The picker dialog's message boundary: wrap its commands back into rail
 *  messages (the informing convention, mirroring the root's Got*Message). */
const wrapDialogCommand = (message: Dialog.Message) => GotPickerDialogMessage({ message });

/** The dialog closed: reset the picker's tree state so the next open
 *  starts at the default root again. */
const pickerClosed = (maybeOut: Option.Option<Dialog.OutMessage>) =>
  Option.isSome(maybeOut) && maybeOut.value._tag === "Closed";

/** Upsert a thread into the list (broadcast order is registry order). The
 *  list holds every thread; the views filter by `archivedAt`. */
const upsertThread = (model: Model, thread: ThreadInfo) => {
  if (model.list._tag !== "Success") return model;
  const threads = model.list.data.some((existing) => existing.id === thread.id)
    ? model.list.data.map((existing) => (existing.id === thread.id ? thread : existing))
    : [...model.list.data, thread];
  return evo(model, { list: (_) => threadList.Success({ data: threads }) });
};

/** Drop a thread from the list. */
const removeThread = (model: Model, id: string) => {
  if (model.list._tag !== "Success") return model;
  const threads = model.list.data.filter((thread) => thread.id !== id);
  return evo(model, { list: (_) => threadList.Success({ data: threads }) });
};

/** Upsert a project into the window. */
const upsertProject = (model: Model, project: ProjectInfo) => {
  if (model.projects._tag !== "Success") return model;
  const projects_ = model.projects.data.some((existing) => existing.path === project.path)
    ? model.projects.data.map((existing) => (existing.path === project.path ? project : existing))
    : [...model.projects.data, project];
  return evo(model, { projects: (_) => projects.Success({ data: projects_ }) });
};

/** Issue the lazy session fetch for every expanded project (the refresh
 *  edge reloads what is already on screen). */
const reloadExpanded = (model: Model): Commands =>
  Object.entries(model.expanded)
    .filter(([, isExpanded]) => isExpanded)
    .map(([path]) => ListProjectSessionsCmd({ path }));

/** The project owning a session path (for re-listing after a failed
 *  adoption); undefined when the window does not contain it. */
const projectOfPath = (model: Model, path: string) =>
  model.projects._tag === "Success"
    ? model.projects.data.find(
        (project) => path.startsWith(`${project.path}/`) || path === project.path,
      )
    : undefined;

export const update = (model: Model, message: RailMessage) =>
  M.value(message).pipe(
    M.withReturnType<UpdateReturn>(),
    M.tagsExhaustive({
      ThreadsListed: ({ threads }) => [
        evo(model, { list: (_) => threadList.Success({ data: threads }), notice: (_) => null }),
        none,
        Option.none(),
      ],
      ListFailed: ({ error }) => [
        evo(model, { list: (_) => threadList.Failure({ error }) }),
        none,
        Option.none(),
      ],
      // Connect re-lists the registry and the window's scope — never every
      // pi session (the projects' sessions load lazily on expand, and the
      // refresh edge reloads what is already on screen).
      RefreshRequested: () => [
        model,
        [ListThreadsCmd(), ListProjectsCmd(), ...reloadExpanded(model)],
        Option.none(),
      ],
      // The registry broadcast: keep the list current (a thread's state,
      // env, name, or archive status changed — the auto-title lands here).
      ThreadChanged: ({ thread }) => [upsertThread(model, thread), none, Option.none()],

      // A row clicked: surface the fact upward and let the root navigate.
      ClickedThread: ({ id }) => [model, none, Option.some(OpenedThread({ id }))],
      DeleteRequested: ({ id }) => [model, [DeleteThreadCmd({ id })], Option.none()],
      // Deleted: surface the fact — the root leaves `/thread/:id` when the
      // deleted thread was the pinned one.
      ThreadDeleted: ({ id }) => [
        removeThread(model, id),
        none,
        Option.some(DeletedThread({ id })),
      ],
      DeleteFailed: ({ error }) => [
        evo(model, { notice: (_) => error.message }),
        none,
        Option.none(),
      ],

      // Archive (CONTEXT.md: Archive): visibility-only, reversible. The
      // landing upserts — the views derive active/archived from archivedAt.
      ArchiveRequested: ({ id }) => [model, [ArchiveThreadCmd({ id })], Option.none()],
      ThreadArchived: ({ thread }) => [upsertThread(model, thread), none, Option.none()],
      ArchiveFailed: ({ error }) => [
        evo(model, { notice: (_) => error.message }),
        none,
        Option.none(),
      ],
      UnarchiveRequested: ({ id }) => [model, [UnarchiveThreadCmd({ id })], Option.none()],
      ThreadUnarchived: ({ thread }) => [upsertThread(model, thread), none, Option.none()],
      UnarchiveFailed: ({ error }) => [
        evo(model, { notice: (_) => error.message }),
        none,
        Option.none(),
      ],

      // Inline rename (double-click the title): draft → commit → landing.
      ThreadRenameRequested: ({ id }) => {
        if (model.list._tag !== "Success") return [model, none, Option.none()];
        const thread = model.list.data.find((t) => t.id === id);
        if (thread === undefined) return [model, none, Option.none()];
        return [evo(model, { renaming: (_) => ({ id, value: thread.name }) }), none, Option.none()];
      },
      ThreadRenameDraftChanged: ({ text }) => {
        const renaming = model.renaming;
        if (renaming === null) return [model, none, Option.none()];
        return [
          evo(model, { renaming: (_) => ({ id: renaming.id, value: text }) }),
          none,
          Option.none(),
        ];
      },
      ThreadRenameCommitted: () => {
        const renaming = model.renaming;
        if (renaming === null) return [model, none, Option.none()];
        return [
          evo(model, { renaming: (_) => null }),
          [RenameThreadCmd({ id: renaming.id, name: renaming.value.trim() })],
          Option.none(),
        ];
      },
      ThreadRenameCancelled: () => [evo(model, { renaming: (_) => null }), none, Option.none()],
      ThreadRenamed: ({ thread }) => [upsertThread(model, thread), none, Option.none()],
      ThreadRenameFailed: ({ error }) => [
        evo(model, { renaming: (_) => null, notice: (_) => error.message }),
        none,
        Option.none(),
      ],

      // The projects window (CONTEXT.md: Project, Pi sessions).
      ProjectsListed: ({ projects: listed }) => [
        evo(model, { projects: (_) => projects.Success({ data: listed }) }),
        reloadExpanded(model),
        Option.none(),
      ],
      ProjectsListFailed: ({ error }) => [
        evo(model, { projects: (_) => projects.Failure({ error }) }),
        none,
        Option.none(),
      ],
      ProjectAdded: ({ project }) => {
        // The add landed: close the picker dialog (its Closed out-message
        // resets the tree state), and open the new project's sessions.
        const [dialog, dialogCommands, maybeOut] = Dialog.close(model.dialog);
        return [
          evo(model, {
            dialog: () => dialog,
            picker: () => (pickerClosed(maybeOut) ? initialPicker() : model.picker),
            projects: (_) => upsertProject(model, project).projects,
            expanded: (expanded) => ({ ...expanded, [project.path]: true }),
          }),
          [
            ...Command.mapMessages(dialogCommands, wrapDialogCommand),
            // Immediate feedback: the new project opens with its sessions.
            ListProjectSessionsCmd({ path: project.path }),
          ],
          Option.none(),
        ];
      },
      ProjectAddFailed: ({ error }) => [
        // The dialog stays open — the user can pick another folder.
        evo(model, { notice: (_) => error.message }),
        none,
        Option.none(),
      ],
      ProjectRemoved: ({ path }) => {
        const projectSessions_ = { ...model.projectSessions };
        delete projectSessions_[path];
        const expanded = { ...model.expanded };
        delete expanded[path];
        const sessionShowMore = { ...model.sessionShowMore };
        delete sessionShowMore[path];
        const projects_ =
          model.projects._tag === "Success"
            ? projects.Success({
                data: model.projects.data.filter((project) => project.path !== path),
              })
            : model.projects;
        return [
          evo(model, {
            projects: (_) => projects_,
            projectSessions: (_) => projectSessions_,
            expanded: (_) => expanded,
            sessionShowMore: (_) => sessionShowMore,
          }),
          none,
          Option.none(),
        ];
      },
      ProjectRemoveFailed: ({ error }) => [
        evo(model, { notice: (_) => error.message }),
        none,
        Option.none(),
      ],
      ProjectSessionsListed: ({ path, sessions: listed }) => [
        evo(model, {
          projectSessions: (map) => ({
            ...map,
            [path]: projectSessions.Success({ data: listed }),
          }),
        }),
        none,
        Option.none(),
      ],
      ProjectSessionsListFailed: ({ path, error }) => [
        evo(model, {
          projectSessions: (map) => ({
            ...map,
            [path]: projectSessions.Failure({ error }),
          }),
        }),
        none,
        Option.none(),
      ],
      ProjectExpanded: ({ path }) => [
        evo(model, { expanded: (expanded) => ({ ...expanded, [path]: true }) }),
        // Load on first expand; cached afterwards (the refresh edge reloads).
        model.projectSessions[path] === undefined ? [ListProjectSessionsCmd({ path })] : none,
        Option.none(),
      ],
      ProjectCollapsed: ({ path }) => [
        evo(model, { expanded: (expanded) => ({ ...expanded, [path]: false }) }),
        none,
        Option.none(),
      ],
      ProjectShowMore: ({ path }) => [
        evo(model, { sessionShowMore: (map) => ({ ...map, [path]: true }) }),
        none,
        Option.none(),
      ],
      ProjectShowLess: ({ path }) => [
        evo(model, { sessionShowMore: (map) => ({ ...map, [path]: false }) }),
        none,
        Option.none(),
      ],
      ThreadShowMore: () => [evo(model, { threadShowMore: (_) => true }), none, Option.none()],
      ThreadShowLess: () => [evo(model, { threadShowMore: (_) => false }), none, Option.none()],

      // The rail's view: active (threads + projects window) or archived.
      ArchivedViewRequested: () => [evo(model, { view: (_) => "archived" }), none, Option.none()],
      ActiveViewRequested: () => [evo(model, { view: (_) => "active" }), none, Option.none()],

      // The add-project picker: a modal dialog (the foldkit Dialog
      // submodel) over a traversable directory tree (CONTEXT.md: Add
      // project). Open issues the browse of the default root; each level
      // lands in `picker`, and descend/up/filter/commit are pure state
      // moves plus one BrowseProjectDirsCmd per level.
      AddProjectRequested: () => {
        if (model.dialog.isOpen) return [model, none, Option.none()];
        const [dialog, dialogCommands] = Dialog.open(model.dialog);
        return [
          evo(model, { dialog: () => dialog }),
          [
            ...Command.mapMessages(dialogCommands, wrapDialogCommand),
            // Start the tree at its default root (the daemon picks it:
            // the deepest common ancestor of the candidates).
            BrowseProjectDirsCmd({ path: "" }),
          ],
          Option.none(),
        ];
      },
      GotPickerDialogMessage: ({ message }) => {
        const [dialog, dialogCommands, maybeOut] = Dialog.update(model.dialog, message);
        const closed = pickerClosed(maybeOut);
        return [
          closed
            ? evo(model, { dialog: () => dialog, picker: () => initialPicker() })
            : evo(model, { dialog: () => dialog }),
          Command.mapMessages(dialogCommands, wrapDialogCommand),
          Option.none(),
        ];
      },
      PickerBrowseListed: ({ path, parent, entries }) => [
        evo(model, {
          picker: (picker) => ({
            ...picker,
            path,
            parent,
            entries: browseEntries.Success({ data: entries }),
            filter: "",
            // Land on the first directory row — Enter goes deeper, not up.
            highlight: parent === null ? 0 : 1,
          }),
        }),
        none,
        Option.none(),
      ],
      PickerBrowseFailed: ({ error }) => [
        evo(model, {
          picker: (picker) => ({ ...picker, entries: browseEntries.Failure({ error }) }),
        }),
        none,
        Option.none(),
      ],
      PickerDirChosen: ({ path }) => [model, [BrowseProjectDirsCmd({ path })], Option.none()],
      PickerUpRequested: () => {
        const parent = model.picker.parent;
        if (parent === null) return [model, none, Option.none()];
        return [model, [BrowseProjectDirsCmd({ path: parent })], Option.none()];
      },
      PickerFilterChanged: ({ text }) => [
        evo(model, {
          picker: (picker) => {
            const rows = pickerRows({ ...picker, filter: text });
            // Land on the first matching directory (not the up row), so
            // typing then Enter descends into the match.
            const firstDir = picker.parent === null ? 0 : 1;
            const last = Math.max(rows.length - 1, 0);
            return { ...picker, filter: text, highlight: Math.min(firstDir, last) };
          },
        }),
        none,
        Option.none(),
      ],
      PickerHighlightMoved: ({ delta }) => {
        const rows = pickerRows(model.picker);
        if (rows.length === 0) return [model, none, Option.none()];
        const next = Math.min(Math.max(model.picker.highlight + delta, 0), rows.length - 1);
        if (next === model.picker.highlight) return [model, none, Option.none()];
        return [
          evo(model, { picker: (picker) => ({ ...picker, highlight: next }) }),
          none,
          Option.none(),
        ];
      },
      PickerAddRequested: ({ path }) => {
        // Guarded: nothing to commit until a level actually landed.
        if (model.picker.entries._tag !== "Success") return [model, none, Option.none()];
        return [model, [AddProjectCmd({ path })], Option.none()];
      },
      RemoveProjectRequested: ({ path }) => [model, [RemoveProjectCmd({ path })], Option.none()],

      // The pi section (CONTEXT.md: Pi sessions). A row clicked: adoption is
      // guarded (no double adoptions); the landed thread opens exactly like
      // a thread row click.
      PiSessionClicked: ({ path }) =>
        model.adopting !== null
          ? [model, none, Option.none()]
          : [evo(model, { adopting: (_) => path }), [AdoptPiSessionCmd({ path })], Option.none()],
      PiSessionAdopted: ({ thread }) => [
        evo(model, {
          adopting: (_) => null,
          // The born thread joins the registry list (the broadcast would
          // land it too; upsert is idempotent either way).
          list: (_) => upsertThread(model, thread).list,
        }),
        none,
        Option.some(OpenedThread({ id: thread.id })),
      ],
      // The adoption failed (e.g. already imported elsewhere — a stale
      // list): show why, release the guard, and re-list the truth.
      PiSessionAdoptFailed: ({ error }) => {
        const project = model.adopting === null ? undefined : projectOfPath(model, model.adopting);
        return [
          evo(model, { adopting: (_) => null, notice: (_) => error.message }),
          [
            ListThreadsCmd(),
            ListProjectsCmd(),
            ...(project === undefined ? [] : [ListProjectSessionsCmd({ path: project.path })]),
          ],
          Option.none(),
        ];
      },
    }),
  );

/** The root's hook for a route change: the rail's only route-derived field
 *  is the selection highlight (the pinned thread's id). */
export const informRouteChanged = (model: Model, route: AppRoute) =>
  evo(model, { selectedId: (_) => (route._tag === "Thread" ? route.id : null) });
