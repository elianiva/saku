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
import { WireError } from "@saku/wire";
import type { PiSessionInfo, ProjectInfo, ThreadInfo } from "@saku/wire";
import type { Arbitrary } from "fast-check";
import {
  array,
  assert,
  constant,
  constantFrom,
  integer,
  oneof,
  property,
  record,
  string,
} from "fast-check";
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

/** A minimal thread helper (archive-neutral). */
const thread = (id: string, name: string): ThreadInfo => ({
  archivedAt: null,
  cwd: null,
  env: "ready",
  id,
  mode: "local",
  name,
  sessionId: null,
  state: "idle",
  tailSeq: 0,
});

/** A minimal project helper. */
const project = (path: string): ProjectInfo => ({ addedAt: 1, path });

/** A minimal pi session helper. */
const piSession = (path: string): PiSessionInfo => ({
  createdAt: 1,
  cwd: "/a",
  firstMessage: "hi",
  id: path,
  messageCount: 1,
  modifiedAt: 1,
  name: "session",
  path,
});

/** Any registry thread the wire could broadcast. */
const threadArb: Arbitrary<ThreadInfo> = record({
  archivedAt: oneof(constant(null), integer()),
  cwd: oneof(constant(null), string({ maxLength: 24 })),
  env: constantFrom("stopped", "provisioning", "ready", "error"),
  id: string({ maxLength: 24 }),
  mode: constantFrom("local", "sandbox", "any"),
  name: string({ maxLength: 24 }),
  sessionId: oneof(constant(null), string({ maxLength: 24 })),
  state: constantFrom("idle", "working", "interrupted"),
  tailSeq: integer({ min: 0 }),
});

const listArb = array(threadArb, { maxLength: 8 });

const wireErrorArb = string({ maxLength: 24 }).map(
  (message) => new WireError({ code: "command_failed", message }),
);

/** Fold ThreadsListed, then one more update, returning the next model. */
const listed = (threads: readonly ThreadInfo[]) =>
  update(initialModel(), ThreadsListed({ threads }))[0];

describe("rail update", () => {
  it("lands any list as Success and clears the notice", () => {
    assert(
      property(
        listArb,
        oneof(constant(null), string({ maxLength: 24 })),
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
    assert(
      property(wireErrorArb, (failure) => {
        const [model] = update(initialModel(), ListFailed({ error: failure }));
        expect(model.list).toEqual({ _tag: "Failure", error: failure });
      }),
    );
  });

  it("refresh re-lists the registry and the projects — never pi sessions", () => {
    assert(
      property(
        oneof(
          constant(initialModel()),
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
    assert(
      property(listArb, threadArb, (threads, incoming) => {
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
    assert(
      property(
        oneof(
          constant(initialModel()),
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
    assert(
      property(string({ maxLength: 24 }), (id) => {
        const [model, commands, out] = update(initialModel(), ClickedThread({ id }));
        expect(model).toEqual(initialModel());
        expect(commands).toHaveLength(0);
        expect(out).toEqual(Option.some({ _tag: "OpenedThread", id }));
      }),
    );
  });

  it("delete request fires the command; the landed delete filters the row and surfaces DeletedThread", () => {
    assert(
      property(listArb, string({ maxLength: 24 }), (threads, id) => {
        const [, commands] = update(listed(threads), DeleteRequested({ id }));
        expect(commands).toHaveLength(1);
        const [model, , out] = update(listed(threads), ThreadDeleted({ id }));
        expect(model.list).toEqual({
          _tag: "Success",
          data: threads.filter((existing) => existing.id !== id),
        });
        expect(out).toEqual(Option.some({ _tag: "DeletedThread", id }));
      }),
    );
  });

  it("a failed delete shows the notice", () => {
    assert(
      property(wireErrorArb, (failure) => {
        const [model] = update(initialModel(), DeleteFailed({ error: failure }));
        expect(model.notice).toBe(failure.message);
      }),
    );
  });

  it("archive: request fires the command; the landing upserts the thread", () => {
    assert(
      property(listArb, threadArb, (threads, incoming) => {
        const [, commands] = update(listed(threads), ArchiveRequested({ id: incoming.id }));
        expect(commands).toHaveLength(1);
        const [model] = update(listed(threads), ThreadArchived({ thread: incoming }));
        const expected = threads.some((existing) => existing.id === incoming.id)
          ? threads.map((existing) => (existing.id === incoming.id ? incoming : existing))
          : [...threads, incoming];
        expect(model.list).toEqual({ _tag: "Success", data: expected });
      }),
    );
  });

  it("unarchive request fires the command; a failed archive shows the notice", () => {
    assert(
      property(threadArb, wireErrorArb, (incoming, error) => {
        const [, commands] = update(initialModel(), UnarchiveRequested({ id: incoming.id }));
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
    const [first] = threads;
    if (first === undefined) {
      throw new Error("expected a thread");
    }
    const renamed = { ...first, name: "new name" };
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
      entries: [
        { hasPiSessions: true, name: "b", path: "/a/b" },
        { hasPiSessions: false, name: "c", path: "/a/c" },
      ],
      parent: "/",
      path: "/a",
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
    const [atRoot] = update(landed, PickerBrowseListed({ entries: [], parent: null, path: "/" }));
    const [stillRoot] = update(atRoot, PickerUpRequested());
    expect(stillRoot.picker).toBe(atRoot.picker);
  });

  it("the picker: the filter narrows rows and resets the highlight; arrows move it, clamped", () => {
    const [opened] = update(initialModel(), AddProjectRequested());
    const level = {
      entries: [
        { hasPiSessions: true, name: "alpha", path: "/a/alpha" },
        { hasPiSessions: false, name: "beta", path: "/a/beta" },
        { hasPiSessions: false, name: "gamma", path: "/a/gamma" },
      ],
      parent: "/",
      path: "/a",
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

    const [landed] = update(opened, PickerBrowseListed({ entries: [], parent: "/", path: "/a" }));
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
        entries: [{ hasPiSessions: true, name: "b", path: "/a/b" }],
        parent: "/",
        path: "/a",
      }),
    );
    const [closed] = update(landed, GotPickerDialogMessage({ message: Dialog.RequestedClose() }));
    expect(closed.dialog.isOpen).toBe(false);
    expect(closed.picker).toEqual(initialPicker());
  });

  it("expanding a project fetches its sessions once; collapsing and removing clean up", () => {
    const [withProjects] = update(initialModel(), ProjectsListed({ projects: [project("/a")] }));
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
    assert(
      property(
        oneof(constant(null), string({ maxLength: 24 })),
        string({ maxLength: 24 }),
        (adopting, path) => {
          const [next, commands] = update(
            { ...initialModel(), adopting },
            PiSessionClicked({ path }),
          );
          if (adopting === null) {
            expect(next).toEqual({ ...initialModel(), adopting: path });
            expect(commands).toHaveLength(1);
          } else {
            expect(next).toEqual({ ...initialModel(), adopting });
            expect(commands).toHaveLength(0);
          }
        },
      ),
    );
  });

  it("an adopted session joins the registry list and surfaces OpenedThread; a failure re-lists the window", () => {
    assert(
      property(listArb, threadArb, wireErrorArb, (threads, incoming, error) => {
        const [adopted, , out] = update(listed(threads), PiSessionAdopted({ thread: incoming }));
        const expected = threads.some((existing) => existing.id === incoming.id)
          ? threads.map((existing) => (existing.id === incoming.id ? incoming : existing))
          : [...threads, incoming];
        expect(adopted.list).toEqual({ _tag: "Success", data: expected });
        expect(adopted.adopting).toBeNull();
        expect(out).toEqual(Option.some({ _tag: "OpenedThread", id: incoming.id }));

        const [model] = update(initialModel(), ProjectsListed({ projects: [project("/a")] }));
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
    assert(
      property(
        oneof(
          constant(initialModel()),
          listArb.map((threads) => listed(threads)),
        ),
        string({ maxLength: 24 }),
        (model, id) => {
          expect(informRouteChanged(model, ThreadsRoute()).selectedId).toBeNull();
          expect(informRouteChanged(model, ThreadRoute({ id })).selectedId).toBe(id);
        },
      ),
    );
  });
});
