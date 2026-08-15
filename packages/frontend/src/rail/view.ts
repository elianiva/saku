/**
 * The thread rail's view (rail/view.ts): the registry projection plus the
 * projects window (CONTEXT.md: Project, Pi sessions) — t3code-style: only a
 * few threads at a time (preview + show more), two-line rows, archive
 * (CONTEXT.md: Archive) as a separate rail view, and the projects section
 * with its explicit add gesture. Row content comes entirely from
 * `thread_changed` broadcasts and command landings; the rail never computes
 * thread state. The archived view holds the settled threads (muted rows,
 * unarchive + delete); the active view is threads + projects.
 *
 * Branded via `defineView` so it embeds under the root through
 * `h.submodel`, with `h` typed to the rail's own Message union (the lutra
 * gallery view pattern).
 */

import { AsyncData, Submodel } from "foldkit";
import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import type { PiSessionInfo, ProjectInfo, ThreadInfo } from "@saku/wire";

import { icon } from "../icon.ts";
import {
  PREVIEW_LIMIT,
  activeThreads,
  archivedThreads,
  envPresentation,
  modeIcon,
  previewSlice,
  projectName,
  relativeTime,
  statePresentation,
  unadoptedPiSessions,
} from "../presentation.ts";
import {
  ActiveViewRequested,
  AddProjectCancelled,
  AddProjectCommitted,
  AddProjectDraftChanged,
  AddProjectRequested,
  ArchivedViewRequested,
  ArchiveRequested,
  ClickedThread,
  DeleteRequested,
  PiSessionClicked,
  ProjectCollapsed,
  ProjectExpanded,
  ProjectShowLess,
  ProjectShowMore,
  RefreshRequested,
  RemoveProjectRequested,
  ThreadRenameCancelled,
  ThreadRenameCommitted,
  ThreadRenameDraftChanged,
  ThreadRenameRequested,
  ThreadShowLess,
  ThreadShowMore,
  UnarchiveRequested,
  type RailMessage,
} from "./message.ts";
import type { Model } from "./model.ts";

export const view = Submodel.defineView<Model, RailMessage>((model, h) =>
  h.aside(
    [h.Class("w-80 shrink-0 border-r border-line bg-surface flex flex-col min-h-0")],
    [railHeader(model, h), notice(model, h), railList(model, h)],
  ),
);

/** A transient failure notice (failed gestures), null when clean. */
const notice = (model: Model, h: HtmlBuilder<RailMessage>) =>
  model.notice === null
    ? null
    : h.div(
        [h.Class("border-b border-love/40 bg-overlay px-3 py-1.5 text-[11px] text-love")],
        [model.notice],
      );

const railHeader = (model: Model, h: HtmlBuilder<RailMessage>) => {
  const count = model.list._tag === "Success" ? activeThreads(model.list.data).length : 0;
  const archived = model.list._tag === "Success" ? archivedThreads(model.list.data).length : 0;
  return h.div(
    [
      h.Class(
        "flex items-center gap-2 px-4 h-9 shrink-0 border-b border-line text-[11px] uppercase tracking-[0.18em] text-subtle",
      ),
    ],
    [
      h.span(
        [h.Class("flex-1")],
        [model.view === "active" ? `threads · ${count}` : `archived · ${archived}`],
      ),
      // The archived toggle (t3code's archived panel, one click away).
      model.view === "active"
        ? h.button(
            [
              h.Class("border border-line px-1.5 hover:border-subtle"),
              h.OnClick(ArchivedViewRequested()),
              h.AriaLabel("show archived threads"),
              h.Title("archived threads"),
              h.Disabled(archived === 0),
            ],
            [icon(h, "archive")],
          )
        : h.button(
            [
              h.Class("border border-line px-1.5 hover:border-subtle"),
              h.OnClick(ActiveViewRequested()),
              h.AriaLabel("show active threads"),
              h.Title("back to active"),
            ],
            [icon(h, "arrowLeft")],
          ),
      h.button(
        [
          h.Class("border border-line px-1.5 hover:border-subtle"),
          h.OnClick(RefreshRequested()),
          h.AriaLabel("refresh thread list"),
          h.Title("refresh"),
        ],
        [icon(h, "refreshCw")],
      ),
    ],
  );
};

const railList = (model: Model, h: HtmlBuilder<RailMessage>) =>
  AsyncData.match(model.list, {
    onIdle: () => railStatus(h, "loading…"),
    onLoading: () => railStatus(h, "loading…"),
    onRefreshing: () => railStatus(h, "loading…"),
    onStale: () => railStatus(h, "loading…"),
    onFailure: (error) => railStatus(h, `threads unavailable — ${error.message}`),
    onSuccess: (threads) =>
      h.div(
        [h.Class("flex-1 overflow-y-auto min-h-0")],
        model.view === "archived"
          ? [archivedList(model, threads, h)]
          : [threadSection(model, threads, h), projectsSection(model, threads, h)],
      ),
  });

const railStatus = (h: HtmlBuilder<RailMessage>, text: string) =>
  h.div([h.Class("p-4 text-muted text-[12px]")], [text]);

/** The show-more toggle (t3code's preview: a few rows at a time). */
const showMoreRow = (
  visible: number,
  total: number,
  expanded: boolean,
  expand: RailMessage,
  collapse: RailMessage,
  h: HtmlBuilder<RailMessage>,
) =>
  total > PREVIEW_LIMIT
    ? h.div(
        [
          h.Class(
            "flex items-center justify-center border-b border-line py-1 text-[11px] uppercase tracking-[0.14em] text-subtle hover:bg-overlay/60 cursor-pointer",
          ),
          h.OnClick(expanded ? collapse : expand),
        ],
        [expanded ? "show less" : `show more · ${total - visible} more`],
      )
    : null;

const threadSection = (
  model: Model,
  threads: readonly ThreadInfo[],
  h: HtmlBuilder<RailMessage>,
) => {
  const active = activeThreads(threads);
  const visible = previewSlice(active, model.threadShowMore);
  return h.div(
    [h.Class("border-b border-line")],
    [
      ...visible.map((thread) => threadRow(model, thread, h)),
      showMoreRow(
        visible.length,
        active.length,
        model.threadShowMore,
        ThreadShowMore(),
        ThreadShowLess(),
        h,
      ),
    ],
  );
};

/** One thread row: two lines (name + state icon / relative time + mode +
 *  env) with hover archive/delete; double-click the title to rename inline.
 *  Archived rows are muted with unarchive instead of archive. */
const threadRow = (model: Model, thread: ThreadInfo, h: HtmlBuilder<RailMessage>) => {
  const selected = thread.id === model.selectedId;
  const archived = thread.archivedAt !== null;
  const renaming = model.renaming !== null && model.renaming.id === thread.id;
  return h.div(
    [
      h.Class(
        `group flex items-center gap-2 px-3 py-2 border-b border-line cursor-pointer text-[13px] ${
          archived ? "text-muted" : selected ? "bg-overlay" : "hover:bg-overlay/60"
        }`,
      ),
      h.OnClick(ClickedThread({ id: thread.id })),
    ],
    [
      archived
        ? h.span([h.Class("text-subtle shrink-0"), h.Title("archived")], [icon(h, "archive")])
        : stateIcon(thread, h),
      h.div(
        [h.Class("flex-1 min-w-0")],
        [
          renaming
            ? renameInput(model, h)
            : h.div(
                [h.Class("truncate"), h.OnDoubleClick(ThreadRenameRequested({ id: thread.id }))],
                [thread.name],
              ),
          archived
            ? h.div(
                [h.Class("text-[11px] text-muted truncate")],
                [`archived ${relativeTime(thread.archivedAt)}`],
              )
            : threadMeta(thread, h),
        ],
      ),
      archived
        ? h.button(
            [
              h.Class("opacity-0 group-hover:opacity-100 text-subtle hover:text-foam px-1"),
              h.OnClick(UnarchiveRequested({ id: thread.id })),
              h.AriaLabel(`unarchive ${thread.name}`),
              h.Title("unarchive"),
            ],
            [icon(h, "archiveRestore")],
          )
        : h.button(
            [
              h.Class("opacity-0 group-hover:opacity-100 text-subtle hover:text-subtle px-1"),
              h.OnClick(ArchiveRequested({ id: thread.id })),
              h.AriaLabel(`archive ${thread.name}`),
              h.Title("archive"),
            ],
            [icon(h, "archive")],
          ),
      h.button(
        [
          h.Class("opacity-0 group-hover:opacity-100 text-subtle hover:text-love px-1"),
          h.OnClick(DeleteRequested({ id: thread.id })),
          h.AriaLabel(`delete ${thread.name}`),
          h.Title("delete thread"),
        ],
        [icon(h, "trash2")],
      ),
    ],
  );
};

/** The inline rename input: Enter commits, Escape cancels, blur cancels. */
const renameInput = (model: Model, h: HtmlBuilder<RailMessage>) => {
  const renaming = model.renaming;
  if (renaming === null) return null;
  return h.input([
    h.Class(
      "w-full border border-line bg-base px-1 text-[13px] text-text outline-none focus:border-subtle",
    ),
    h.Value(renaming.value),
    h.OnInput((text) => ThreadRenameDraftChanged({ text })),
    h.OnKeyDownPreventDefault((key) =>
      key === "Enter"
        ? Option.some(ThreadRenameCommitted())
        : key === "Escape"
          ? Option.some(ThreadRenameCancelled())
          : Option.none(),
    ),
    h.OnBlur(ThreadRenameCancelled()),
  ]);
};

const stateIcon = (thread: ThreadInfo, h: HtmlBuilder<RailMessage>) => {
  const { icon: iconName, tone, title } = statePresentation(thread.state);
  return h.span([h.Class(tone), h.Title(title)], [icon(h, iconName)]);
};

const threadMeta = (thread: ThreadInfo, h: HtmlBuilder<RailMessage>) => {
  const env = envPresentation(thread.env);
  return h.div(
    [h.Class("flex items-center gap-1 text-[11px] text-muted truncate")],
    [
      h.span([h.Class("shrink-0"), h.Title(thread.mode)], [icon(h, modeIcon(thread.mode))]),
      h.span([h.Class("shrink-0")], [icon(h, env.icon, { className: env.tone })]),
    ],
  );
};

/** The projects window: the added projects and their lazy session lists
 *  (CONTEXT.md: Project, Pi sessions). Hidden on a failed list (a remote
 *  hub has no projects — same story as the sessions themselves). */
const projectsSection = (
  model: Model,
  threads: readonly ThreadInfo[],
  h: HtmlBuilder<RailMessage>,
) =>
  AsyncData.match(model.projects, {
    onIdle: () => null,
    onLoading: () => null,
    onRefreshing: () => null,
    onStale: () => null,
    onFailure: () => null,
    onSuccess: (listed) =>
      h.div(
        [h.Class("border-b border-line")],
        [
          h.div(
            [h.Class("flex items-center gap-2 px-3 pt-2 pb-1")],
            [
              h.span(
                [h.Class("flex-1 text-[10px] uppercase tracking-[0.18em] text-subtle")],
                [`projects · ${listed.length}`],
              ),
              h.button(
                [
                  h.Class("border border-line px-1.5 text-subtle hover:border-subtle"),
                  h.OnClick(AddProjectRequested()),
                  h.AriaLabel("add a project"),
                  h.Title("add a project (CONTEXT.md: Add project)"),
                ],
                [icon(h, "plus")],
              ),
            ],
          ),
          model.adding ? addProjectInput(model, h) : null,
          ...listed.map((project) => projectRow(model, project, threads, h)),
          listed.length === 0 && !model.adding
            ? h.div(
                [h.Class("px-3 pb-2 text-[11px] text-muted")],
                ["no projects — add one to see its pi sessions"],
              )
            : null,
        ],
      ),
  });

/** The add-project input: a path, committed on Enter (Escape/blur cancel). */
/** The add-project input: a path, committed on Enter (Escape/blur cancel),
 *  with the picker's candidates below (click to fill the draft). */
const addProjectInput = (model: Model, h: HtmlBuilder<RailMessage>) =>
  h.div(
    [h.Class("px-3 pb-2")],
    [
      h.input([
        h.Class("w-full border border-line bg-base px-1.5 py-1 text-[12px] text-text outline-none"),
        h.Placeholder("/path/to/project"),
        h.Value(model.addDraft),
        h.OnInput((text) => AddProjectDraftChanged({ text })),
        h.OnKeyDownPreventDefault((key) =>
          key === "Enter" && model.addDraft.trim().length > 0
            ? Option.some(AddProjectCommitted())
            : key === "Escape"
              ? Option.some(AddProjectCancelled())
              : Option.none(),
        ),
        h.OnBlur(AddProjectCancelled()),
      ]),
      projectCandidatesList(model, h),
    ],
  );

/** The picker: the cwds pi has sessions for (decoded lossily daemon-side). */
const projectCandidatesList = (model: Model, h: HtmlBuilder<RailMessage>) =>
  AsyncData.match(model.candidates, {
    onIdle: () => null,
    onLoading: () => null,
    onRefreshing: () => null,
    onStale: () => null,
    onFailure: () => null,
    onSuccess: (candidates) => {
      const shown = candidates.filter((candidate) => candidate !== model.addDraft.trim());
      if (shown.length === 0) return null;
      return h.div(
        [h.Class("mt-1 max-h-40 overflow-y-auto border border-line bg-base")],
        shown.map((candidate) =>
          h.div(
            [
              h.Class(
                "px-2 py-1 text-[11px] text-subtle cursor-pointer truncate hover:bg-overlay/60",
              ),
              h.OnClick(AddProjectDraftChanged({ text: candidate })),
            ],
            [candidate],
          ),
        ),
      );
    },
  });

/** One project row: name + muted path, expand/collapse, remove. The
 *  session list is lazy — fetched on first expand and cached. */
const projectRow = (
  model: Model,
  project: ProjectInfo,
  threads: readonly ThreadInfo[],
  h: HtmlBuilder<RailMessage>,
) => {
  const expanded = model.expanded[project.path] === true;
  return h.div(
    [h.Class("border-t border-line")],
    [
      h.div(
        [
          h.Class("group flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-overlay/60"),
          h.OnClick(
            expanded
              ? ProjectCollapsed({ path: project.path })
              : ProjectExpanded({ path: project.path }),
          ),
        ],
        [
          h.span(
            [
              h.Class("text-subtle shrink-0 text-[10px]"),
              h.Title(expanded ? "collapse" : "expand"),
            ],
            [icon(h, expanded ? "chevronDown" : "chevronRight")],
          ),
          h.div(
            [h.Class("flex-1 min-w-0")],
            [
              h.div([h.Class("truncate text-[12px] text-text")], [projectName(project.path)]),
              h.div([h.Class("truncate text-[10px] text-muted")], [project.path]),
            ],
          ),
          h.button(
            [
              h.Class("opacity-0 group-hover:opacity-100 text-subtle hover:text-love px-1"),
              h.OnClick(RemoveProjectRequested({ path: project.path })),
              h.AriaLabel(`remove project ${project.path}`),
              h.Title("remove from the window (threads are untouched)"),
            ],
            [icon(h, "x")],
          ),
        ],
      ),
      expanded ? projectSessions(model, project, threads, h) : null,
    ],
  );
};

/** One project's session list: AsyncData with loading/failure states, the
 *  unadopted filter, and the same preview mechanic as the threads. */
const projectSessions = (
  model: Model,
  project: ProjectInfo,
  threads: readonly ThreadInfo[],
  h: HtmlBuilder<RailMessage>,
) => {
  const state = model.projectSessions[project.path];
  if (state === undefined) return null; // the expand arm issues the fetch
  return AsyncData.match(state, {
    onIdle: () => sessionsStatus(h, "loading…"),
    onLoading: () => sessionsStatus(h, "loading…"),
    onRefreshing: () => sessionsStatus(h, "loading…"),
    onStale: () => sessionsStatus(h, "loading…"),
    onFailure: (error) => sessionsStatus(h, `unavailable — ${error.message}`),
    onSuccess: (sessions) => {
      const unadopted = unadoptedPiSessions(threads, sessions);
      const showMore = model.sessionShowMore[project.path] === true;
      const visible = previewSlice(unadopted, showMore);
      if (unadopted.length === 0) return sessionsStatus(h, "no pi sessions for this project yet");
      return h.div(
        [h.Class("border-t border-line/60")],
        [
          ...visible.map((session) => piSessionRow(session, model.adopting, h)),
          showMoreRow(
            visible.length,
            unadopted.length,
            showMore,
            ProjectShowMore({ path: project.path }),
            ProjectShowLess({ path: project.path }),
            h,
          ),
        ],
      );
    },
  });
};

const sessionsStatus = (h: HtmlBuilder<RailMessage>, text: string) =>
  h.div([h.Class("px-6 py-1 text-[11px] text-muted border-t border-line/60")], [text]);

/** One pi session: click to adopt and open — the import is not an event the
 *  user performs, it is what opening a session means (CONTEXT.md: Pi
 *  sessions). Two lines: title + relative time and message count. */
const piSessionRow = (
  session: PiSessionInfo,
  adopting: string | null,
  h: HtmlBuilder<RailMessage>,
) => {
  const busy = adopting === session.path;
  const title =
    session.name ?? (session.firstMessage === "(no messages)" ? session.id : session.firstMessage);
  return h.button(
    [
      h.Class(
        `w-full flex items-center gap-2 px-6 py-1.5 text-left text-[12px] ${busy ? "text-muted" : "hover:bg-overlay/60"}`,
      ),
      h.OnClick(PiSessionClicked({ path: session.path })),
      h.Disabled(busy),
      h.Title(session.path),
    ],
    [
      h.span([h.Class("text-subtle shrink-0"), h.Title("pi session")], [icon(h, "pi")]),
      h.div(
        [h.Class("flex-1 min-w-0")],
        [
          h.div([h.Class("truncate")], [busy ? "opening…" : title]),
          h.div(
            [h.Class("text-[10px] text-muted")],
            [`${relativeTime(session.modifiedAt)} · ${session.messageCount} msgs`],
          ),
        ],
      ),
    ],
  );
};

/** The archived view: every settled thread, muted, with unarchive + delete. */
const archivedList = (model: Model, threads: readonly ThreadInfo[], h: HtmlBuilder<RailMessage>) =>
  h.div(
    [h.Class("border-b border-line")],
    archivedThreads(threads).map((thread) => threadRow(model, thread, h)),
  );
