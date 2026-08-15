/**
 * The rail update's property tests (update.test.ts): the grid transitions
 * (list/refresh/broadcast upsert), the delete flow, the projects window
 * (list landing, lazy per-project sessions, expand, add/remove, the guarded
 * adoption), the archive flow (request → landing moves the thread between
 * views), and the OutMessages the rail surfaces to the root. Exercised as
 * pure updates; the commands are asserted, never executed.
 *
 * The list semantics are pinned as properties over arbitrary lists and
 * threads: a broadcast upserts in place when the id is present (replacing
 * every occurrence) and appends otherwise; a delete filters the list; and
 * the click/delete OutMessages carry the id through unchanged. The
 * before-the-list-lands arms (Idle/Failure) are no-ops.
 */

import { describe, expect, it } from "vitest";
import { Option } from "effect";
import * as Dialog from "@foldkit/ui/dialog";
import { WireError, type PiSessionInfo, type ProjectInfo, type ThreadInfo } from "@saku/wire";
import fc from "fast-check";

import { ThreadsRoute, ThreadRoute } from "../route.ts";
import { update, informRouteChanged } from "./update.ts";
import { browseEntries, initialModel, initialPicker, projectSessions, projects } from "./model.ts";
import {
  ActiveViewRequested,
  AddProjectRequested,
  ArchiveFailed,
  ArchiveRequested,
  ArchivedViewRequested,
  ClickedThread,
  DeleteFailed,
  DeleteRequested,
  GotPickerDialogMessage,
  ListFailed,
  PickerAddRequested,
  PickerBrowseFailed,
  PickerBrowseListed,
  PickerDirChosen,
  PickerFilterChanged,
  PickerHighlightMoved,
  PickerUpRequested,
  PiSessionAdoptFailed,
  PiSessionAdopted,
  PiSessionClicked,
  ProjectAdded,
  ProjectCollapsed,
  ProjectExpanded,
  ProjectRemoved,
  ProjectSessionsListed,
  ProjectsListed,
  RefreshRequested,
  ThreadArchived,
  ThreadChanged,
  ThreadDeleted,
  ThreadRenameCancelled,
  ThreadRenameCommitted,
  ThreadRenameDraftChanged,
  ThreadRenameRequested,
  ThreadRenamed,
  ThreadsListed,
  ThreadShowMore,
  ThreadShowLess,
  UnarchiveRequested,
} from "./message.ts";

/** Any registry thread the wire could broadcast. */
const threadArb: fc.Arbitrary<ThreadInfo> = fc.record({
  id: fc.string({ maxLength: 24 }),
  name: fc.string({ maxLength: 24 }),
  cwd: fc.oneof(fc.constant(null), fc.string({ maxLength: 24 })),
  mode: fc.constantFrom("local", "sandbox", "any"),
  state: fc.constantFrom("idle", "working", "interrupted"),
  env: fc.constantFrom("stopped", "provisioning", "ready", "error"),
  sessionId: fc.oneof(fc.constant(null), fc.string({ maxLength: 24 })),
  tailSeq: fc.integer({ min: 0 }),
  archivedAt: fc.oneof(fc.constant(null), fc.integer()),
});

const listArb = fc.array(threadArb, { maxLength: 8 });

const piSessionArb: fc.Arbitrary<PiSessionInfo> = fc.record({
  id: fc.string({ maxLength: 24 }),
  cwd: fc.string({ maxLength: 24 }),
  name: fc.string({ maxLength: 24 }),
  createdAt: fc.integer(),
  modifiedAt: fc.integer(),
  messageCount: fc.integer({ min: 0 }),
  firstMessage: fc.string({ maxLength: 24 }),
  path: fc.string({ maxLength: 24 }),
});

const projectArb: fc.Arbitrary<ProjectInfo> = fc.record({
  path: fc.string({ maxLength: 24 }),
  addedAt: fc.integer(),
});

const wireErrorArb = fc
  .string({ maxLength: 24 })
  .map((message) => new WireError({ code: "command_failed", message }));

/** Fold ThreadsListed, then one more update, returning the next model. */
const listed = (threads: readonly ThreadInfo[]) =>
  update(initialModel(), ThreadsListed({ threads }))[0];

describe("rail update", () => {
  it("lands any list as Success and clears the notice", () => {
    fc.assert(
      fc.property(
        listArb,
        fc.oneof(fc.constant(null), fc.string({ maxLength: 24 })),
        (threads, staleNotice) => {
          const [model] = update(
            { ...initialModel(), notice: staleNotice },
            ThreadsListed({ threads }),
          );
          expect(model.list).toEqual({ _tag: "Success", data: threads });
          expect(model.notice).toBeNull();
        },
      ),
    );
  });

  it("lands any failure as the list's Failure", () => {
    fc.assert(
      fc.property(wireErrorArb, (error) => {
        const [model] = update(initialModel(), ListFailed({ error }));
        expect(model.list).toEqual({ _tag: "Failure", error });
      }),
    );
  });

  it("refresh re-lists the registry and the projects — never pi sessions", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(initialModel()),
          listArb.map((threads) => listed(threads)),
        ),
        (model) => {
          const [next, commands] = update(model, RefreshRequested());
          expect(next).toEqual(model);
          expect(commands).toHaveLength(2);
        },
      ),
    );
  });

  it("a broadcast upserts in place and appends otherwise", () => {
    fc.assert(
      fc.property(listArb, threadArb, (threads, incoming) => {
        const [model] = update(listed(threads), ThreadChanged({ thread: incoming }));
        const known = threads.some((existing) => existing.id === incoming.id);
        const expected = known
          ? threads.map((existing) => (existing.id === incoming.id ? incoming : existing))
          : [...threads, incoming];
        expect(model.list).toEqual({ _tag: "Success", data: expected });
      }),
    );
  });

  it("a broadcast before the list lands is a no-op", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(initialModel()),
          wireErrorArb.map((error) => update(initialModel(), ListFailed({ error }))[0]),
        ),
        threadArb,
        (model, incoming) => {
          const [next, commands] = update(model, ThreadChanged({ thread: incoming }));
          expect(next).toEqual(model);
          expect(commands).toHaveLength(0);
        },
      ),
    );
  });

  it("a row click surfaces OpenedThread with the id, leaving the model alone", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 24 }), (id) => {
        const [model, commands, out] = update(initialModel(), ClickedThread({ id }));
        expect(model).toEqual(initialModel());
        expect(commands).toHaveLength(0);
        expect(out).toEqual(Option.some({ _tag: "OpenedThread", id }));
      }),
    );
  });

  it("delete request fires the command; the landed delete filters the row and surfaces DeletedThread", () => {
    fc.assert(
      fc.property(listArb, fc.string({ maxLength: 24 }), (threads, id) => {
        const [, commands] = update(listed(threads), DeleteRequested({ id }));
        expect(commands).toHaveLength(1);
        const [model, , out] = update(listed(threads), ThreadDeleted({ id }));
        expect(model.list).toEqual({
          _tag: "Success",
          data: threads.filter((thread) => thread.id !== id),
        });
        expect(out).toEqual(Option.some({ _tag: "DeletedThread", id }));
      }),
    );
  });

  it("a failed delete shows the notice", () => {
    fc.assert(
      fc.property(wireErrorArb, (error) => {
        const [model] = update(initialModel(), DeleteFailed({ error }));
        expect(model.notice).toBe(error.message);
      }),
    );
  });

  it("archive: request fires the command; the landing upserts the thread", () => {
    fc.assert(
      fc.property(listArb, threadArb, (threads, thread) => {
        const [, commands] = update(listed(threads), ArchiveRequested({ id: thread.id }));
        expect(commands).toHaveLength(1);
        const [model] = update(listed(threads), ThreadArchived({ thread }));
        const expected = threads.some((existing) => existing.id === thread.id)
          ? threads.map((existing) => (existing.id === thread.id ? thread : existing))
          : [...threads, thread];
        expect(model.list).toEqual({ _tag: "Success", data: expected });
      }),
    );
  });

  it("unarchive request fires the command; a failed archive shows the notice", () => {
    fc.assert(
      fc.property(threadArb, wireErrorArb, (thread, error) => {
        const [, commands] = update(initialModel(), UnarchiveRequested({ id: thread.id }));
        expect(commands).toHaveLength(1);
        const [model] = update(initialModel(), ArchiveFailed({ error }));
        expect(model.notice).toBe(error.message);
      }),
    );
  });

  it("rename: double-click opens the draft, typing updates it, Enter commits the command", () => {
    const threads = [thread("t1", "old name")];
    const [drafting] = update(listed(threads), ThreadRenameRequested({ id: "t1" }));
    expect(drafting.renaming).toEqual({ id: "t1", value: "old name" });

    const [typed] = update(drafting, ThreadRenameDraftChanged({ text: "new name" }));
    expect(typed.renaming).toEqual({ id: "t1", value: "new name" });

    const [committed, commands] = update(typed, ThreadRenameCommitted());
    expect(committed.renaming).toBeNull();
    expect(commands).toHaveLength(1);

    // Escape cancels without a command.
    const [cancelled, cancelledCommands] = update(drafting, ThreadRenameCancelled());
    expect(cancelled.renaming).toBeNull();
    expect(cancelledCommands).toHaveLength(0);
  });

  it("a renamed landing upserts the thread", () => {
    const threads = [thread("t1", "old name")];
    const renamed = { ...threads[0]!, name: "new name" };
    const [model] = update(listed(threads), ThreadRenamed({ thread: renamed }));
    expect(model.list).toEqual({ _tag: "Success", data: [renamed] });
  });

  it("projects: the list lands, and refresh re-fetches the expanded projects' sessions", () => {
    const model = {
      ...initialModel(),
      expanded: { "/a": true, "/b": false },
    };
    const [landed] = update(model, ProjectsListed({ projects: [project("/a"), project("/b")] }));
    expect(landed.projects).toEqual(projects.Success({ data: [project("/a"), project("/b")] }));
    const [, commands] = update(landed, RefreshRequested());
    // Threads + projects + the one expanded project's sessions.
    expect(commands).toHaveLength(3);
  });

  it("adding a project expands it, fetches its sessions, and closes the picker", () => {
    const [opened, openCommands] = update(initialModel(), AddProjectRequested());
    expect(opened.dialog.isOpen).toBe(true);
    // The dialog opens (its ShowDialog command wrapped) and the tree
    // starts at its default root.
    expect(openCommands.map((command) => command.name)).toEqual([
      "ShowDialog",
      "BrowseProjectDirs",
    ]);

    const [added, commands] = update(opened, ProjectAdded({ project: project("/a") }));
    expect(added.dialog.isOpen).toBe(false);
    expect(added.picker).toEqual(initialPicker());
    expect(added.expanded["/a"]).toBe(true);
    expect(commands.map((command) => command.name)).toEqual(["CloseDialog", "ListProjectSessions"]);
  });

  it("the picker: browse levels land, and descend/up move the tree", () => {
    const [opened] = update(initialModel(), AddProjectRequested());
    const level = {
      path: "/a",
      parent: "/",
      entries: [
        { name: "b", path: "/a/b", hasPiSessions: true },
        { name: "c", path: "/a/c", hasPiSessions: false },
      ],
    };
    const [landed] = update(opened, PickerBrowseListed(level));
    expect(landed.picker.path).toBe("/a");
    expect(landed.picker.parent).toBe("/");
    expect(landed.picker.entries).toEqual(browseEntries.Success({ data: level.entries }));
    expect(landed.picker.filter).toBe("");
    // The first directory row (not the up row) is highlighted.
    expect(landed.picker.highlight).toBe(1);

    // Descend into the highlighted dir; ascend back to the parent.
    const [, downCommands] = update(landed, PickerDirChosen({ path: "/a/b" }));
    expect(downCommands.map((command) => command.name)).toEqual(["BrowseProjectDirs"]);
    const [, upCommands] = update(landed, PickerUpRequested());
    expect(upCommands.map((command) => command.name)).toEqual(["BrowseProjectDirs"]);

    // At the filesystem root the up gesture is a no-op.
    const [atRoot] = update(landed, PickerBrowseListed({ path: "/", parent: null, entries: [] }));
    const [stillRoot] = update(atRoot, PickerUpRequested());
    expect(stillRoot.picker).toBe(atRoot.picker);
  });

  it("the picker: the filter narrows rows and resets the highlight; arrows move it, clamped", () => {
    const [opened] = update(initialModel(), AddProjectRequested());
    const level = {
      path: "/a",
      parent: "/",
      entries: [
        { name: "alpha", path: "/a/alpha", hasPiSessions: true },
        { name: "beta", path: "/a/beta", hasPiSessions: false },
        { name: "gamma", path: "/a/gamma", hasPiSessions: false },
      ],
    };
    const [landed] = update(opened, PickerBrowseListed(level));

    const [moved] = update(landed, PickerHighlightMoved({ delta: 2 }));
    expect(moved.picker.highlight).toBe(3);
    // Clamped: 3 rows (up + alpha + beta + gamma) — the highlight cannot
    // pass the last row.
    const [clamped] = update(moved, PickerHighlightMoved({ delta: 1 }));
    expect(clamped.picker.highlight).toBe(3);
    const [clampedDown] = update(clamped, PickerHighlightMoved({ delta: -4 }));
    expect(clampedDown.picker.highlight).toBe(0);

    // Filtering resets the highlight to the first matching directory.
    const [filtered] = update(clampedDown, PickerFilterChanged({ text: "BETA" }));
    expect(filtered.picker.filter).toBe("BETA");
    expect(filtered.picker.highlight).toBe(1);
  });

  it("the picker: add is guarded until a level lands, then fires the command", () => {
    const [opened] = update(initialModel(), AddProjectRequested());
    // Nothing landed yet: the commit is a no-op.
    const [unlanded] = update(opened, PickerAddRequested({ path: "/a" }));
    expect(unlanded).toBe(opened);

    const [landed] = update(opened, PickerBrowseListed({ path: "/a", parent: "/", entries: [] }));
    const [, commands] = update(landed, PickerAddRequested({ path: "/a" }));
    expect(commands.map((command) => command.name)).toEqual(["AddProject"]);

    // A failed browse surfaces inline and keeps the dialog usable.
    const [failed] = update(
      landed,
      PickerBrowseFailed({ error: new WireError({ code: "command_failed", message: "nope" }) }),
    );
    expect(failed.picker.entries._tag).toBe("Failure");
  });

  it("the picker: closing the dialog resets the tree state", () => {
    const [opened] = update(initialModel(), AddProjectRequested());
    const [landed] = update(
      opened,
      PickerBrowseListed({
        path: "/a",
        parent: "/",
        entries: [{ name: "b", path: "/a/b", hasPiSessions: true }],
      }),
    );
    const [closed] = update(landed, GotPickerDialogMessage({ message: Dialog.RequestedClose() }));
    expect(closed.dialog.isOpen).toBe(false);
    expect(closed.picker).toEqual(initialPicker());
  });

  it("expanding a project fetches its sessions once; collapsing and removing clean up", () => {
    const withProjects = update(initialModel(), ProjectsListed({ projects: [project("/a")] }))[0];
    const [expanded, commands] = update(withProjects, ProjectExpanded({ path: "/a" }));
    expect(expanded.expanded["/a"]).toBe(true);
    expect(commands).toHaveLength(1);

    // The landed session list is cached under the project's path.
    const [landed] = update(
      expanded,
      ProjectSessionsListed({ path: "/a", sessions: [piSession("/a/s1")] }),
    );
    expect(landed.projectSessions["/a"]).toEqual(
      projectSessions.Success({ data: [piSession("/a/s1")] }),
    );

    // Re-expanding after collapse does not refetch (cached).
    const [collapsed] = update(landed, ProjectCollapsed({ path: "/a" }));
    const [reExpanded, againCommands] = update(collapsed, ProjectExpanded({ path: "/a" }));
    expect(againCommands).toHaveLength(0);
    expect(reExpanded.expanded["/a"]).toBe(true);

    // Removing the project drops its cached sessions and expansion.
    const [removed, removeCommands] = update(reExpanded, ProjectRemoved({ path: "/a" }));
    expect(removeCommands).toHaveLength(0);
    expect(removed.projectSessions["/a"]).toBeUndefined();
    expect(removed.expanded["/a"]).toBeUndefined();
  });

  it("the view toggles between active and archived", () => {
    const [archived] = update(initialModel(), ArchivedViewRequested());
    expect(archived.view).toBe("archived");
    const [active] = update(archived, ActiveViewRequested());
    expect(active.view).toBe("active");
  });

  it("the thread preview expands and collapses", () => {
    const [more] = update(initialModel(), ThreadShowMore());
    expect(more.threadShowMore).toBe(true);
    const [less] = update(more, ThreadShowLess());
    expect(less.threadShowMore).toBe(false);
  });

  it("a pi session click is guarded: one adoption in flight, then no-ops", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(null), fc.string({ maxLength: 24 })),
        fc.string({ maxLength: 24 }),
        (adopting, path) => {
          const [next, commands] = update(
            { ...initialModel(), adopting },
            PiSessionClicked({ path }),
          );
          if (adopting !== null) {
            expect(next).toEqual({ ...initialModel(), adopting });
            expect(commands).toHaveLength(0);
          } else {
            expect(next).toEqual({ ...initialModel(), adopting: path });
            expect(commands).toHaveLength(1);
          }
        },
      ),
    );
  });

  it("an adopted session joins the registry list and surfaces OpenedThread; a failure re-lists the window", () => {
    fc.assert(
      fc.property(listArb, threadArb, wireErrorArb, (threads, thread, error) => {
        const [adopted, , out] = update(listed(threads), PiSessionAdopted({ thread }));
        const expected = threads.some((existing) => existing.id === thread.id)
          ? threads.map((existing) => (existing.id === thread.id ? thread : existing))
          : [...threads, thread];
        expect(adopted.list).toEqual({ _tag: "Success", data: expected });
        expect(adopted.adopting).toBeNull();
        expect(out).toEqual(Option.some({ _tag: "OpenedThread", id: thread.id }));

        const model = update(initialModel(), ProjectsListed({ projects: [project("/a")] }))[0];
        const [failed, failedCommands] = update(
          { ...model, adopting: "/a/s1" },
          PiSessionAdoptFailed({ error }),
        );
        expect(failed.adopting).toBeNull();
        expect(failed.notice).toBe(error.message);
        // The failure re-lists threads + projects + the containing project.
        expect(failedCommands).toHaveLength(3);
      }),
    );
  });

  it("informRouteChanged tracks the pinned thread for the row highlight", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(initialModel()),
          listArb.map((threads) => listed(threads)),
        ),
        fc.string({ maxLength: 24 }),
        (model, id) => {
          expect(informRouteChanged(model, ThreadsRoute()).selectedId).toBeNull();
          expect(informRouteChanged(model, ThreadRoute({ id })).selectedId).toBe(id);
        },
      ),
    );
  });
});

/** A minimal thread helper (archive-neutral). */
const thread = (id: string, name: string): ThreadInfo => ({
  id,
  name,
  cwd: null,
  mode: "local",
  state: "idle",
  env: "ready",
  sessionId: null,
  tailSeq: 0,
  archivedAt: null,
});

/** A minimal project helper. */
const project = (path: string): ProjectInfo => ({ path, addedAt: 1 });

/** A minimal pi session helper. */
const piSession = (path: string): PiSessionInfo => ({
  id: path,
  cwd: "/a",
  name: "session",
  createdAt: 1,
  modifiedAt: 1,
  messageCount: 1,
  firstMessage: "hi",
  path,
});
