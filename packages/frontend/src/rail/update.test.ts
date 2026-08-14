/**
 * The rail update's unit tests (update.test.ts): the grid transitions
 * (list/refresh/broadcast upsert), the quick-start flow, the delete flow,
 * and the OutMessages the rail surfaces to the root. Exercised as pure
 * updates; the commands are asserted, never executed.
 */

import { describe, expect, it } from "vitest";
import { Option } from "effect";
import { WireError } from "@saku/wire";
import type { ThreadInfo } from "@saku/wire";

import { ThreadsRoute, ThreadRoute } from "../route.ts";
import { update, informRouteChanged } from "./update.ts";
import { initialModel } from "./model.ts";
import {
  ClickedThread,
  CreateFailed,
  DeleteFailed,
  DeleteRequested,
  ListFailed,
  QuickStartRequested,
  RailInputChanged,
  RefreshRequested,
  ThreadChanged,
  ThreadCreated,
  ThreadDeleted,
  ThreadsListed,
} from "./message.ts";

const thread = (id: string, name = id): ThreadInfo => ({
  id,
  name,
  cwd: null,
  mode: "local",
  state: "idle",
  env: "ready",
  sessionId: null,
  tailSeq: 0,
});

const wireError = (message: string): WireError =>
  new WireError({ code: "command_failed", message });

describe("rail update", () => {
  it("lands the list as Success and clears the notice", () => {
    const [model] = update(
      { ...initialModel(), notice: "stale" },
      ThreadsListed({ threads: [thread("a"), thread("b")] }),
    );
    expect(model.list).toEqual({
      _tag: "Success",
      data: [thread("a"), thread("b")],
    });
    expect(model.notice).toBeNull();
  });

  it("lands a failure as the list's Failure", () => {
    const [model] = update(initialModel(), ListFailed({ error: wireError("boom") }));
    expect(model.list).toEqual({ _tag: "Failure", error: wireError("boom") });
  });

  it("refresh re-lists", () => {
    const [, commands] = update(initialModel(), RefreshRequested());
    expect(commands).toHaveLength(1);
  });

  it("a broadcast upserts an existing thread in place", () => {
    const listed = update(initialModel(), ThreadsListed({ threads: [thread("a", "old")] }))[0];
    const [model] = update(listed, ThreadChanged({ thread: thread("a", "new") }));
    expect(model.list).toEqual({ _tag: "Success", data: [thread("a", "new")] });
  });

  it("a broadcast appends an unknown thread", () => {
    const listed = update(initialModel(), ThreadsListed({ threads: [thread("a")] }))[0];
    const [model] = update(listed, ThreadChanged({ thread: thread("b") }));
    expect(model.list).toEqual({ _tag: "Success", data: [thread("a"), thread("b")] });
  });

  it("a broadcast before the list lands is a no-op", () => {
    const [model] = update(initialModel(), ThreadChanged({ thread: thread("a") }));
    expect(model.list).toEqual({ _tag: "Idle" });
  });

  it("quick start trims and clears the input, firing the command", () => {
    const typed = update(initialModel(), RailInputChanged({ text: "  build it  " }))[0];
    const [model, commands] = update(typed, QuickStartRequested());
    expect(model.input).toBe("");
    expect(commands).toHaveLength(1);
  });

  it("quick start with a blank input is a no-op", () => {
    const [model, commands] = update(initialModel(), QuickStartRequested());
    expect(model).toEqual(initialModel());
    expect(commands).toHaveLength(0);
  });

  it("a created thread upserts and surfaces OpenedThread to the root", () => {
    const listed = update(initialModel(), ThreadsListed({ threads: [thread("a")] }))[0];
    const [model, , out] = update(listed, ThreadCreated({ thread: thread("b") }));
    expect(model.list).toEqual({ _tag: "Success", data: [thread("a"), thread("b")] });
    expect(out).toEqual(Option.some({ _tag: "OpenedThread", id: "b" }));
  });

  it("a failed create shows the notice", () => {
    const [model] = update(initialModel(), CreateFailed({ error: wireError("nope") }));
    expect(model.notice).toBe("nope");
  });

  it("a row click surfaces OpenedThread to the root", () => {
    const [, , out] = update(initialModel(), ClickedThread({ id: "a" }));
    expect(out).toEqual(Option.some({ _tag: "OpenedThread", id: "a" }));
  });

  it("delete request fires the command; the landed delete removes the row and surfaces DeletedThread", () => {
    const listed = update(
      initialModel(),
      ThreadsListed({ threads: [thread("a"), thread("b")] }),
    )[0];
    const [, commands] = update(listed, DeleteRequested({ id: "a" }));
    expect(commands).toHaveLength(1);
    const [model, , out] = update(listed, ThreadDeleted({ id: "a" }));
    expect(model.list).toEqual({ _tag: "Success", data: [thread("b")] });
    expect(out).toEqual(Option.some({ _tag: "DeletedThread", id: "a" }));
  });

  it("a failed delete shows the notice", () => {
    const [model] = update(initialModel(), DeleteFailed({ error: wireError("nope") }));
    expect(model.notice).toBe("nope");
  });

  it("informRouteChanged tracks the pinned thread for the row highlight", () => {
    expect(informRouteChanged(initialModel(), ThreadsRoute()).selectedId).toBeNull();
    expect(informRouteChanged(initialModel(), ThreadRoute({ id: "a" })).selectedId).toBe("a");
  });
});
