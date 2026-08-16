/**
 * The thread rail's view (rail/view.ts): the registry projection plus the
 * projects window (CONTEXT.md: Project, Pi sessions) — t3code-style: only a
 * few threads at a time (preview + show more), two-line rows, archive
 * (CONTEXT.md: Archive) as a separate rail view, the projects section
 * with its explicit add gesture, and the add-project picker — a modal
 * dialog over a traversable directory tree (CONTEXT.md: Add project). Row
 * content comes entirely from `thread_changed` broadcasts and command
 * landings; the rail never computes thread state. The archived view holds
 * the settled threads (muted rows, unarchive + delete); the active view is
 * threads + projects.
 *
 * Branded via `defineView` so it embeds under the root through
 * `h.submodel`, with `h` typed to the rail's own Message union (the lutra
 * gallery view pattern). The picker dialog embeds the foldkit Dialog
 * submodel the same way (the website's dialog page pattern).
 */

import { AsyncData, Submodel } from "foldkit";
import { Option } from "effect";
import * as Dialog from "@foldkit/ui/dialog";
import type { ChildAttribute, HtmlBuilder, KeyboardModifiers } from "foldkit/html";
import type { PiSessionInfo, ProjectDirEntry, ProjectInfo, ThreadInfo } from "@saku/wire";

import { icon } from "../icon.ts";
import {
  PREVIEW_LIMIT,
  activeThreads,
  archivedThreads,
  envPresentation,
  modeIcon,
  pickerRows,
  previewSlice,
  projectName,
  relativeTime,
  statePresentation,
  unadoptedPiSessions,
} from "../presentation.ts";
import type { PickerRow } from "../presentation.ts";
import {
  ActiveViewRequested,
  AddProjectRequested,
  ArchivedViewRequested,
  ArchiveRequested,
  ClickedThread,
  DeleteRequested,
  GotPickerDialogMessage,
  PickerAddRequested,
  PickerDirChosen,
  PickerFilterChanged,
  PickerHighlightMoved,
  PickerUpRequested,
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
} from "./message.ts";
import type { RailMessage } from "./message.ts";
import type { Model } from "./model.ts";

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

/** A thread row's tone: muted when archived, highlighted when selected. */
const rowTone = (archived: boolean, selected: boolean) => {
  if (archived) {
    return "text-muted";
  }
  if (selected) {
    return "bg-overlay";
  }
  return "hover:bg-overlay/60";
};

/** The inline rename input: Enter commits, Escape cancels, blur cancels. */
const renameKey = (key: string): Option.Option<RailMessage> => {
  if (key === "Enter") {
    return Option.some(ThreadRenameCommitted());
  }
  if (key === "Escape") {
    return Option.some(ThreadRenameCancelled());
  }
  return Option.none();
};

const renameInput = (model: Model, h: HtmlBuilder<RailMessage>) => {
  const { renaming } = model;
  if (renaming === null) {
    return null;
  }
  return h.input([
    h.Class(
      "w-full border border-line bg-base px-1 text-[13px] text-text outline-none focus:border-subtle",
    ),
    h.Value(renaming.value),
    h.OnInput((text) => ThreadRenameDraftChanged({ text })),
    h.OnKeyDownPreventDefault(renameKey),
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
        `group flex items-center gap-2 px-3 py-2 border-b border-line cursor-pointer text-[13px] ${rowTone(archived, selected)}`,
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

const pickerHeader = (
  model: Model,
  h: HtmlBuilder<RailMessage>,
  title: readonly ChildAttribute[],
  description: readonly ChildAttribute[],
  closeButton: readonly ChildAttribute[],
) =>
  h.div(
    [h.Class("flex items-center gap-2 px-4 h-10 shrink-0 border-b border-line")],
    [
      h.span(
        [...title, h.Class("flex-1 text-[11px] uppercase tracking-[0.18em] text-subtle")],
        ["add project"],
      ),
      // The dialog's accessible description, visually hidden.
      h.p([...description, h.Class("sr-only")], ["choose a folder to add as a project"]),
      h.button(
        [
          ...closeButton,
          h.Class("border border-line px-1.5 text-subtle hover:border-subtle"),
          h.Title("close"),
          h.AriaLabel("close"),
        ],
        [icon(h, "x")],
      ),
    ],
  );

/** The current directory: an up button (disabled at the filesystem root)
 *  and the path itself. */
const pickerPath = (model: Model, h: HtmlBuilder<RailMessage>) =>
  h.div(
    [h.Class("flex items-center gap-2 px-4 py-2 shrink-0 border-b border-line")],
    [
      h.button(
        [
          h.Class("border border-line px-1.5 text-subtle hover:border-subtle shrink-0"),
          h.Disabled(model.picker.parent === null),
          h.OnClick(PickerUpRequested()),
          h.Title("up a level"),
          h.AriaLabel("up a level"),
        ],
        [icon(h, "arrowUp")],
      ),
      h.span(
        [
          h.Class("flex-1 min-w-0 truncate font-mono text-[11px] text-muted"),
          h.Title(model.picker.path),
        ],
        [model.picker.path === "" ? "…" : model.picker.path],
      ),
    ],
  );

/** The keyboard map of the picker's filter input (pseudo-TUI: keys, not
 *  clicks, drive the tree). Enter acts on the highlighted row; ⌘/Ctrl+Enter
 *  adds it directly (t3code's browse); Backspace on an empty filter goes
 *  up a level. Committing the current folder is the footer button's
 *  gesture — Enter never adds anything implicitly. */
const pickerKey = (
  key: string,
  modifiers: KeyboardModifiers,
  model: Model,
): Option.Option<RailMessage> => {
  const rows = pickerRows(model.picker);
  const highlighted = rows[model.picker.highlight];
  if (key === "ArrowDown") {
    return Option.some(PickerHighlightMoved({ delta: 1 }));
  }
  if (key === "ArrowUp") {
    return Option.some(PickerHighlightMoved({ delta: -1 }));
  }
  if (key === "Backspace" && model.picker.filter === "") {
    return Option.some(PickerUpRequested());
  }
  if (key !== "Enter") {
    return Option.none();
  }
  if (highlighted === undefined) {
    return Option.none();
  }
  if (modifiers.metaKey || modifiers.ctrlKey) {
    return highlighted.kind === "dir"
      ? Option.some(PickerAddRequested({ path: highlighted.entry.path }))
      : Option.some(PickerUpRequested());
  }
  return highlighted.kind === "dir"
    ? Option.some(PickerDirChosen({ path: highlighted.entry.path }))
    : Option.some(PickerUpRequested());
};

/** The filter input: narrows the current level by basename; the keyboard
 *  drives the tree (↑↓ highlight, Enter descend / ⌘Enter add, ⌫ up). */
const pickerFilter = (
  model: Model,
  h: HtmlBuilder<RailMessage>,
  initialFocus: readonly ChildAttribute[],
) =>
  h.div(
    [h.Class("px-4 pt-2 pb-1 shrink-0")],
    [
      h.input([
        ...initialFocus,
        h.Class(
          "w-full border border-line bg-base px-2 py-1 text-[12px] text-text outline-none focus:border-subtle",
        ),
        h.Placeholder("filter the current folder…"),
        h.Value(model.picker.filter),
        h.AriaLabel("filter the current folder"),
        h.OnInput((text) => PickerFilterChanged({ text })),
        h.OnKeyDownPreventDefault((key, modifiers) => pickerKey(key, modifiers, model)),
      ]),
    ],
  );

const pickerStatus = (h: HtmlBuilder<RailMessage>, text: string) =>
  h.div([h.Class("px-4 py-3 text-[11px] text-muted")], [text]);

/** The row badges: a pi marker when pi has sessions for this exact cwd
 *  (the picker's candidates), an added marker when the project is already
 *  in the window. */
const pickerBadges = (model: Model, entry: ProjectDirEntry, h: HtmlBuilder<RailMessage>) => {
  const added =
    model.projects._tag === "Success" &&
    model.projects.data.some((project) => project.path === entry.path);
  if (added) {
    return h.span(
      [h.Class("shrink-0 text-foam flex items-center gap-1 text-[10px]"), h.Title("already added")],
      [icon(h, "check"), "added"],
    );
  }
  if (entry.hasPiSessions) {
    return h.span(
      [
        h.Class("shrink-0 text-subtle flex items-center gap-1 text-[10px]"),
        h.Title("pi has sessions here"),
      ],
      [icon(h, "pi"), "pi"],
    );
  }
  return null;
};

/** One row: the up row (navigate to the parent level) or a subdirectory
 *  with its badges (pi has sessions here / already added). */
const pickerRow = (model: Model, row: PickerRow, index: number, h: HtmlBuilder<RailMessage>) => {
  const selected = index === model.picker.highlight;
  const rowClass = `flex items-center gap-2 px-4 py-1.5 cursor-pointer text-[12px] border-b border-line/60 ${selected ? "bg-overlay" : "hover:bg-overlay/60"}`;
  if (row.kind === "up") {
    return h.div(
      [h.Class(rowClass), h.OnClick(PickerUpRequested())],
      [
        h.span([h.Class("text-subtle shrink-0")], [icon(h, "arrowUp")]),
        h.span([h.Class("text-[10px] uppercase tracking-[0.14em] text-subtle")], [".."]),
      ],
    );
  }
  return h.div(
    [
      h.Class(rowClass),
      h.OnClick(PickerDirChosen({ path: row.entry.path })),
      h.Title(row.entry.path),
    ],
    [
      h.span([h.Class("text-subtle shrink-0")], [icon(h, "folder")]),
      h.span([h.Class("flex-1 min-w-0 truncate")], [row.entry.name]),
      pickerBadges(model, row.entry, h),
    ],
  );
};

/** The tree's current level: the up row, then the filtered subdirectories. */
const pickerList = (model: Model, h: HtmlBuilder<RailMessage>) =>
  h.div(
    [h.Class("flex-1 min-h-0 overflow-y-auto border-t border-line")],
    [
      AsyncData.match(model.picker.entries, {
        onFailure: (error) => pickerStatus(h, `cannot list — ${error.message}`),
        onIdle: () => pickerStatus(h, "loading…"),
        onLoading: () => pickerStatus(h, "loading…"),
        onRefreshing: () => pickerStatus(h, "loading…"),
        onStale: () => pickerStatus(h, "loading…"),
        onSuccess: () => {
          const rows = pickerRows(model.picker);
          if (rows.length === 0) {
            return pickerStatus(
              h,
              model.picker.filter.trim() === "" ? "empty folder" : "no matches",
            );
          }
          return h.div(
            [],
            rows.map((row, index) => pickerRow(model, row, index, h)),
          );
        },
      }),
    ],
  );

/** The footer: the key hints and the commit gesture — add the directory
 *  currently listed (an empty new folder is a project too). */
const pickerFooter = (model: Model, h: HtmlBuilder<RailMessage>) =>
  h.div(
    [h.Class("flex items-center gap-3 px-4 py-2 shrink-0 border-t border-line")],
    [
      h.span(
        [h.Class("flex-1 text-[10px] uppercase tracking-[0.14em] text-subtle")],
        ["↑↓ move · enter open · ⌘enter add · ⌫ up · esc close"],
      ),
      h.button(
        [
          h.Class(
            "border border-line px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-subtle hover:border-subtle",
          ),
          h.Disabled(model.picker.entries._tag !== "Success"),
          h.OnClick(PickerAddRequested({ path: model.picker.path })),
          h.Title("add this folder as a project"),
        ],
        ["add this folder"],
      ),
    ],
  );

/** The add-project picker (CONTEXT.md: Add project): a modal dialog — the
 *  foldkit Dialog submodel (focus trap, Esc, backdrop click, ARIA) — over
 *  a traversable directory tree. The tree is one level at a time: the
 *  current directory's subdirectories, the pi-session candidates marked,
 *  traversed by descending (click/Enter), ascending (up row / ⌫), and
 *  filtering (t3code's local-folder browse, the same shape). */
const pickerDialog = (model: Model, h: HtmlBuilder<RailMessage>) =>
  h.submodel({
    model: model.dialog,
    slotId: "project-picker",
    toParentMessage: (message) => GotPickerDialogMessage({ message }),
    view: Dialog.view,
    viewInputs: {
      toView: ({
        dialog,
        backdrop,
        panel,
        title,
        description,
        closeButton,
        initialFocus,
        isVisible,
      }) =>
        h.dialog(
          [...dialog, h.Class("bg-transparent p-0 m-auto open:flex items-center justify-center")],
          isVisible
            ? [
                h.div([...backdrop, h.Class("fixed inset-0 bg-base/75")], []),
                h.div(
                  [
                    ...panel,
                    h.Class(
                      "relative w-[560px] max-w-[calc(100vw-3rem)] max-h-[min(80vh,36rem)] bg-surface border border-line shadow-xl flex flex-col",
                    ),
                  ],
                  [
                    pickerHeader(model, h, title, description, closeButton),
                    pickerPath(model, h),
                    pickerFilter(model, h, initialFocus),
                    pickerList(model, h),
                    pickerFooter(model, h),
                  ],
                ),
              ]
            : [],
        ),
    },
  });

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

/** One project's session list: AsyncData with loading/failure states, the
 *  unadopted filter, and the same preview mechanic as the threads. */
const projectSessions = (
  model: Model,
  project: ProjectInfo,
  threads: readonly ThreadInfo[],
  h: HtmlBuilder<RailMessage>,
) => {
  const state = model.projectSessions[project.path];
  // The expand arm issues the fetch; nothing renders until it lands.
  if (state === undefined) {
    return null;
  }
  return AsyncData.match(state, {
    onFailure: (error) => sessionsStatus(h, `unavailable — ${error.message}`),
    onIdle: () => sessionsStatus(h, "loading…"),
    onLoading: () => sessionsStatus(h, "loading…"),
    onRefreshing: () => sessionsStatus(h, "loading…"),
    onStale: () => sessionsStatus(h, "loading…"),
    onSuccess: (sessions) => {
      const unadopted = unadoptedPiSessions(threads, sessions);
      const showMore = model.sessionShowMore[project.path] === true;
      const visible = previewSlice(unadopted, showMore);
      if (unadopted.length === 0) {
        return sessionsStatus(h, "no pi sessions for this project yet");
      }
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

/** The projects window: the added projects and their lazy session lists
 *  (CONTEXT.md: Project, Pi sessions). Hidden on a failed list (a remote
 *  hub has no projects — same story as the sessions themselves). */
const projectsSection = (
  model: Model,
  threads: readonly ThreadInfo[],
  h: HtmlBuilder<RailMessage>,
) =>
  AsyncData.match(model.projects, {
    onFailure: () => null,
    onIdle: () => null,
    onLoading: () => null,
    onRefreshing: () => null,
    onStale: () => null,
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
          ...listed.map((project) => projectRow(model, project, threads, h)),
          listed.length === 0
            ? h.div(
                [h.Class("px-3 pb-2 text-[11px] text-muted")],
                ["no projects — add one to see its pi sessions"],
              )
            : null,
        ],
      ),
  });

/** The archived view: every settled thread, muted, with unarchive + delete. */
const archivedList = (model: Model, threads: readonly ThreadInfo[], h: HtmlBuilder<RailMessage>) =>
  h.div(
    [h.Class("border-b border-line")],
    archivedThreads(threads).map((thread) => threadRow(model, thread, h)),
  );

const railList = (model: Model, h: HtmlBuilder<RailMessage>) =>
  AsyncData.match(model.list, {
    onFailure: (error) => railStatus(h, `threads unavailable — ${error.message}`),
    onIdle: () => railStatus(h, "loading…"),
    onLoading: () => railStatus(h, "loading…"),
    onRefreshing: () => railStatus(h, "loading…"),
    onStale: () => railStatus(h, "loading…"),
    onSuccess: (threads) =>
      h.div(
        [h.Class("flex-1 overflow-y-auto min-h-0")],
        model.view === "archived"
          ? [archivedList(model, threads, h)]
          : [threadSection(model, threads, h), projectsSection(model, threads, h)],
      ),
  });
export const view = Submodel.defineView<Model, RailMessage>((model, h) =>
  h.aside(
    [h.Class("w-80 shrink-0 border-r border-line bg-surface flex flex-col min-h-0")],
    [railHeader(model, h), notice(model, h), railList(model, h), pickerDialog(model, h)],
  ),
);
