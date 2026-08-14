/**
 * The thread update's unit tests (update.test.ts): the session-event fold
 * wiring (scroll command on a growing view), the trail landing, the
 * composer's gating, and the route-derived `informRouteChanged`. Exercised
 * as pure updates; the commands are asserted, never executed.
 */

import { describe, expect, it } from "vitest";
import type { ThreadInfo } from "@saku/wire";

import { ThreadsRoute, ThreadRoute } from "../route.ts";
import { informRouteChanged, update } from "./update.ts";
import { initialModel, type Model } from "./model.ts";
import { Trail } from "./live.ts";
import {
  ComposerChanged,
  PromptAcked,
  SendFailed,
  SendRequested,
  SessionEvent,
  ThreadChanged,
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
    const [, noId] = update(initialModel(), SendRequested());
    expect(noId).toHaveLength(0);
    const blank = update({ ...modelWith(), composer: "   " }, SendRequested());
    expect(blank[1]).toHaveLength(0);
    const [, commands] = update({ ...modelWith(), composer: "hello" }, SendRequested());
    expect(commands).toHaveLength(1);
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
});
