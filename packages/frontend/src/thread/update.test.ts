/**
 * The thread update's unit tests (update.test.ts): the session-event fold
 * wiring (scroll command on a growing view), the trail landing, the
 * composer's gating, the welcome's quick-start flow (the gesture lives on
 * the pane now), and the route-derived `informRouteChanged`. Exercised as
 * pure updates; the commands are asserted, never executed.
 */

import { describe, expect, it } from "vitest";
import { Option } from "effect";
import { WireError, type PiSessionInfo, type ThreadInfo } from "@saku/wire";

import { ThreadsRoute, ThreadRoute } from "../route.ts";
import { informRouteChanged, update } from "./update.ts";
import { initialModel, PiPicker, type Model } from "./model.ts";
import { Trail } from "./live.ts";
import {
  ComposerBlurred,
  ComposerChanged,
  ComposerFocused,
  CreateFailed,
  PiImportFailed,
  PiImportRequested,
  PiImported,
  PiPickerClosed,
  PiSessionsListed,
  PiSessionsListFailed,
  PiSessionsRequested,
  PromptAcked,
  SendFailed,
  SendRequested,
  SessionEvent,
  ThreadChanged,
  ThreadCreated,
  TrailFailed,
  TrailLoaded,
} from "./message.ts";

const modelWith = (id: string | null = "a"): Model => ({ ...initialModel(), id });

const threadInfo = (id: string, name = id): ThreadInfo => ({
  id,
  name,
  cwd: null,
  mode: "local",
  state: "idle",
  env: "ready",
  sessionId: null,
  tailSeq: 0,
});

const piSession = (id: string): PiSessionInfo => ({
  id,
  cwd: "/tmp/work",
  name: "adopt me",
  createdAt: 1,
  modifiedAt: 2,
  messageCount: 3,
  firstMessage: "hi",
  path: `/tmp/work/${id}.jsonl`,
});

describe("thread update", () => {
  it("folds a session event and fires the scroll command when the view grew", () => {
    const [model, commands] = update(
      modelWith(),
      SessionEvent({ event: { _tag: "message_start", message: { content: "hi" } } }),
    );
    expect(model.live.message).toBe("hi");
    expect(commands).toHaveLength(1);
  });

  it("a settled event clears the live region without a scroll", () => {
    const streamed = update(
      modelWith(),
      SessionEvent({ event: { _tag: "message_start", message: { content: "hi" } } }),
    )[0];
    const [model, commands] = update(streamed, SessionEvent({ event: { _tag: "settled" } }));
    expect(model.live).toEqual({ tools: [] });
    expect(commands).toHaveLength(0);
  });

  it("ignores a registry broadcast for another thread", () => {
    const [model, commands] = update(modelWith("a"), ThreadChanged({ thread: threadInfo("b") }));
    expect(model.info).toBeNull();
    expect(commands).toHaveLength(0);
  });

  it("keeps the header info current from a broadcast for this thread", () => {
    const [model] = update(modelWith("a"), ThreadChanged({ thread: threadInfo("a", "new name") }));
    expect(model.info?.name).toBe("new name");
  });

  it("lands the trail read as Success and scrolls", () => {
    const [model, commands] = update(modelWith(), TrailLoaded({ entries: [], tailSeq: 3 }));
    expect(model.trail).toEqual(Trail.Success({ data: { entries: [], tailSeq: 3 } }));
    expect(commands).toHaveLength(1);
  });

  it("lands a trail failure", () => {
    const [model] = update(modelWith(), TrailFailed({ error: "boom" }));
    expect(model.trail).toEqual(Trail.Failure({ error: "boom" }));
  });

  it("send requires a pinned thread and non-blank text", () => {
    // No thread pinned and no draft: nothing to do (the welcome is idle).
    const [, noId] = update(initialModel(), SendRequested());
    expect(noId).toHaveLength(0);
    // Blank text on a pinned thread: nothing to send.
    const blank = update({ ...modelWith(), composer: "   " }, SendRequested());
    expect(blank[1]).toHaveLength(0);
    // A real draft on a pinned thread: prompt the thread.
    const [, commands] = update({ ...modelWith(), composer: "hello" }, SendRequested());
    expect(commands).toHaveLength(1);
  });

  it("on the welcome, send is the quick start: it trims the draft and fires the command", () => {
    const [model, commands] = update(
      { ...initialModel(), composer: "  build it  " },
      SendRequested(),
    );
    expect(model.starting).toBe(true);
    expect(commands).toHaveLength(1);
  });

  it("the starting guard ignores send while a quick start is in flight", () => {
    const inFlight = { ...initialModel(), composer: "build it", starting: true };
    const [model, commands] = update(inFlight, SendRequested());
    expect(model.starting).toBe(true);
    expect(commands).toHaveLength(0);
  });

  it("a created thread clears the draft and guard, and surfaces OpenedThread to the root", () => {
    const [model, , out] = update(
      { ...initialModel(), composer: "build it", starting: true, focused: true },
      ThreadCreated({ thread: threadInfo("b", "build it") }),
    );
    expect(model.composer).toBe("");
    expect(model.starting).toBe(false);
    expect(model.focused).toBe(false);
    expect(out).toEqual(Option.some({ _tag: "OpenedThread", id: "b" }));
  });

  it("a failed create releases the guard, keeps the draft, and shows the notice", () => {
    const [model] = update(
      { ...initialModel(), composer: "build it", starting: true },
      CreateFailed({ message: "nope" }),
    );
    expect(model.starting).toBe(false);
    expect(model.composer).toBe("build it");
    expect(model.notice).toBe("nope");
  });

  it("focus and blur drive the focus-aware placeholder", () => {
    expect(update(initialModel(), ComposerFocused())[0].focused).toBe(true);
    expect(update({ ...initialModel(), focused: true }, ComposerBlurred())[0].focused).toBe(false);
  });

  it("an acked prompt clears the composer; a failed one shows the notice", () => {
    const typed = update(modelWith(), ComposerChanged({ text: "hello" }))[0];
    expect(update(typed, PromptAcked())[0].composer).toBe("");
    expect(update(typed, SendFailed({ message: "nope" }))[0].notice).toBe("nope");
  });

  it("informRouteChanged pins a Thread route, resets the view, and reads the trail", () => {
    const [model, commands] = informRouteChanged(initialModel(), ThreadRoute({ id: "a" }));
    expect(model.id).toBe("a");
    expect(model.info).toBeNull();
    expect(model.trail).toEqual(Trail.Idle());
    expect(model.live).toEqual({ tools: [] });
    expect(commands).toHaveLength(1);
  });

  it("informRouteChanged unpins on the Threads route without commands", () => {
    const seeded = informRouteChanged(initialModel(), ThreadRoute({ id: "a" }))[0];
    const [model, commands] = informRouteChanged(seeded, ThreadsRoute());
    expect(model.id).toBeNull();
    expect(model.trail).toEqual(Trail.Idle());
    expect(commands).toHaveLength(0);
  });

  it("informRouteChanged preserves the composer draft", () => {
    const drafted = { ...modelWith(), composer: "draft" };
    const [model] = informRouteChanged(drafted, ThreadRoute({ id: "b" }));
    expect(model.composer).toBe("draft");
  });

  it("informRouteChanged resets the focus state across routes", () => {
    const focused = { ...initialModel(), focused: true };
    expect(informRouteChanged(focused, ThreadRoute({ id: "a" }))[0].focused).toBe(false);
    expect(informRouteChanged(focused, ThreadsRoute())[0].focused).toBe(false);
  });

  it("the pi picker opens on the welcome and fires the list command", () => {
    const [model, commands] = update(initialModel(), PiSessionsRequested());
    expect(model.piPicker._tag).toBe("Loading");
    expect(commands).toHaveLength(1);
  });

  it("the pi picker will not open on a pinned thread", () => {
    const [model, commands] = update(modelWith("a"), PiSessionsRequested());
    expect(model.piPicker._tag).toBe("Idle");
    expect(commands).toHaveLength(0);
  });

  it("the pi list lands as Success and a failed list lands as Failure", () => {
    const opened = update(initialModel(), PiSessionsRequested())[0];
    const [listed] = update(opened, PiSessionsListed({ sessions: [piSession("s1")] }));
    expect(listed.piPicker).toEqual(PiPicker.Success({ data: [piSession("s1")] }));

    const error = new WireError({ code: "command_failed", message: "scan failed" });
    const [failed] = update(initialModel(), PiSessionsListFailed({ error }));
    expect(failed.piPicker._tag).toBe("Failure");
  });

  it("a row click fires the import command, guarded per path", () => {
    const session = piSession("s1");
    const [importing, commands] = update(initialModel(), PiImportRequested({ path: session.path }));
    expect(importing.importing).toBe(session.path);
    expect(commands).toHaveLength(1);
    // A second click while in flight is a no-op.
    const [again, againCommands] = update(importing, PiImportRequested({ path: session.path }));
    expect(again.importing).toBe(session.path);
    expect(againCommands).toHaveLength(0);
  });

  it("an imported thread clears the picker and surfaces OpenedThread", () => {
    const opened = {
      ...initialModel(),
      piPicker: PiPicker.Success({ data: [piSession("s1")] }),
      importing: "/tmp/work/s1.jsonl",
    };
    const [model, , out] = update(opened, PiImported({ thread: threadInfo("b", "adopt me") }));
    expect(model.piPicker._tag).toBe("Idle");
    expect(model.importing).toBeNull();
    expect(out).toEqual(Option.some({ _tag: "OpenedThread", id: "b" }));
  });

  it("a failed import releases the guard and shows the notice", () => {
    const opened = { ...initialModel(), importing: "/tmp/work/s1.jsonl" };
    const [model] = update(
      opened,
      PiImportFailed({ error: new WireError({ code: "command_failed", message: "nope" }) }),
    );
    expect(model.importing).toBeNull();
    expect(model.notice).toBe("nope");
  });

  it("closing the picker returns it to Idle", () => {
    const opened = { ...initialModel(), piPicker: PiPicker.Loading() };
    const [model] = update(opened, PiPickerClosed());
    expect(model.piPicker._tag).toBe("Idle");
  });
});
