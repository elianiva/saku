/**
 * The live state machine's unit tests (live.test.ts): the streaming fold —
 * message_start/update/end, tool_execution_*, the complete-entry-clears-
 * streaming-copy invariant, entry_appended during loading, dedupe, and the
 * settled reset — exercised as pure functions. No foldkit runtime, no DOM,
 * no wire service.
 */

import { describe, expect, it } from "vitest";

import { emptyLiveRegion, foldLive, initialLive, type Live } from "../src/live.ts";
import type {
  EntryProjection,
  MessageProjection,
  SessionEventProjection,
} from "../src/projection.ts";

// -- fixtures ---------------------------------------------------------------

/** A ready trail with the given entries already loaded. */
const ready = (entries: EntryProjection[] = [], tailSeq = 0): Live => ({
  trail: { _tag: "ready", entries, tailSeq },
  live: emptyLiveRegion(),
});

/** Fold a stream of events, keeping the final state. */
const fold = (state: Live, ...events: SessionEventProjection[]): Live =>
  events.reduce((current, event) => foldLive(current, event)[0], state);

const textBlock = (text: string) => ({ type: "text", text });
const thinkingBlock = (thinking: string) => ({ type: "thinking", thinking });

const messageStart = (content: MessageProjection["content"]): SessionEventProjection => ({
  _tag: "message_start",
  message: { content },
});
const messageUpdate = (content: MessageProjection["content"]): SessionEventProjection => ({
  _tag: "message_update",
  message: { content },
});
const messageEnd = (content: MessageProjection["content"]): SessionEventProjection => ({
  _tag: "message_end",
  message: { content },
});

const toolStart = (callId: string, toolName = "bash"): SessionEventProjection => ({
  _tag: "tool_execution_start",
  toolCallId: callId,
  toolName,
});
const toolUpdate = (callId: string, partialResult: unknown): SessionEventProjection => ({
  _tag: "tool_execution_update",
  toolCallId: callId,
  partialResult,
});
const toolEnd = (callId: string, result: unknown, isError = false): SessionEventProjection => ({
  _tag: "tool_execution_end",
  toolCallId: callId,
  isError,
  result,
});

const entry = (id: string, type = "message", seq?: number): EntryProjection => ({
  id,
  type,
  ...(seq === undefined ? {} : { seq }),
});
const entryAppended = (entry: EntryProjection): SessionEventProjection => ({
  _tag: "entry_appended",
  entry,
});

const settled: SessionEventProjection = { _tag: "settled" };
const compactionStart = (reason: "manual" | "threshold" | "overflow"): SessionEventProjection => ({
  _tag: "compaction_start",
  reason,
});
const compactionEnd: SessionEventProjection = {
  _tag: "compaction_end",
  reason: "manual",
  aborted: false,
};
const unhandled: SessionEventProjection = { _tag: "unhandled", event: { type: "some_future_event" } };

// -- the message stream -----------------------------------------------------

describe("message stream", () => {
  it("folds start/update/end into the streaming message", () => {
    const state = fold(
      initialLive(),
      messageStart("hello"),
      messageUpdate("hello, world"),
      messageEnd("hello, world!"),
    );
    expect(state.live.message).toBe("hello, world!");
    expect(state.trail).toEqual({ _tag: "loading" });
  });

  it("replaces the streamed text with each update's text", () => {
    // Streaming semantics: every update carries the current full text
    // (start/update/end replace, never append — an empty text keeps the
    // previous value, see below).
    const state = fold(initialLive(), messageStart([textBlock("hello")]), messageUpdate([textBlock("there")]));
    expect(state.live.message).toBe("there");
  });

  it("folds thinking in from updates, separately from the message body", () => {
    const state = fold(
      initialLive(),
      messageStart("hi"),
      messageUpdate([thinkingBlock("deep thought"), textBlock(" there")]),
    );
    expect(state.live.thinking).toBe("deep thought");
    expect(state.live.message).toBe("there");
  });

  it("preserves a stream field when an update carries an empty one", () => {
    const state = fold(initialLive(), messageStart("hi"), messageUpdate([thinkingBlock("deep")]));
    expect(state.live.message).toBe("hi");
    expect(state.live.thinking).toBe("deep");
    // An update with both fields empty keeps both values.
    const after = fold(state, messageUpdate(""));
    expect(after.live.message).toBe("hi");
    expect(after.live.thinking).toBe("deep");
  });

  it("requests a scroll on every message event", () => {
    const [start, startScroll] = foldLive(initialLive(), messageStart("hi"));
    expect(start.live.message).toBe("hi");
    expect(startScroll).toBe(true);
    const [updated, updateScroll] = foldLive(start, messageUpdate("hi there"));
    expect(updated.live.message).toBe("hi there");
    expect(updateScroll).toBe(true);
    const [, endScroll] = foldLive(updated, messageEnd("hi there!"));
    expect(endScroll).toBe(true);
  });
});

// -- tool execution ---------------------------------------------------------

describe("tool execution", () => {
  it("folds start/update/end into one tool row", () => {
    const state = fold(
      initialLive(),
      toolStart("call_1", "bash"),
      toolUpdate("call_1", "compiling…"),
      toolEnd("call_1", "compiled"),
    );
    expect(state.live.tools).toEqual([
      { callId: "call_1", name: "bash", state: "done", partial: "compiling…", result: "compiled" },
    ]);
  });

  it("marks an error run failed with its result", () => {
    const state = fold(initialLive(), toolStart("call_1"), toolEnd("call_1", "boom", true));
    expect(state.live.tools[0]?.state).toBe("failed");
    expect(state.live.tools[0]?.result).toBe("boom");
  });

  it("tracks parallel tools by call id", () => {
    const state = fold(
      initialLive(),
      toolStart("call_1", "read"),
      toolStart("call_2", "bash"),
      toolUpdate("call_1", "partial one"),
      toolEnd("call_2", "done two"),
    );
    expect(state.live.tools).toEqual([
      { callId: "call_1", name: "read", state: "running", partial: "partial one" },
      { callId: "call_2", name: "bash", state: "done", result: "done two" },
    ]);
  });

  it("leaves the tools untouched for an unknown call id", () => {
    const state = fold(initialLive(), toolStart("call_1"), toolUpdate("call_9", "x"), toolEnd("call_9", "y"));
    expect(state.live.tools).toEqual([{ callId: "call_1", name: "bash", state: "running" }]);
  });

  it("stringifies non-string partials and results", () => {
    const state = fold(initialLive(), toolStart("call_1"), toolUpdate("call_1", { lines: 3 }), toolEnd("call_1", [1, 2]));
    expect(state.live.tools[0]?.partial).toBe('{"lines":3}');
    expect(state.live.tools[0]?.result).toBe("[1,2]");
  });

  it("does not request a scroll for tool activity", () => {
    const [, startScroll] = foldLive(initialLive(), toolStart("call_1"));
    const [state, updateScroll] = foldLive(initialLive(), toolUpdate("call_1", "x"));
    const [, endScroll] = foldLive(state, toolEnd("call_1", "y"));
    expect(startScroll).toBe(false);
    expect(updateScroll).toBe(false);
    expect(endScroll).toBe(false);
  });
});

// -- the trail --------------------------------------------------------------

describe("entry_appended", () => {
  it("grows the trail and bumps tailSeq", () => {
    const [state, scroll] = foldLive(ready([entry("e1", "message", 1)], 1), entryAppended(entry("e2", "message", 5)));
    expect(state.trail).toEqual({
      _tag: "ready",
      entries: [entry("e1", "message", 1), entry("e2", "message", 5)],
      tailSeq: 5,
    });
    expect(scroll).toBe(true);
  });

  it("never lowers tailSeq", () => {
    const state = fold(ready([entry("e1", "message", 10)], 10), entryAppended(entry("e2", "message")));
    expect(state.trail).toEqual({
      _tag: "ready",
      entries: [entry("e1", "message", 10), entry("e2", "message")],
      tailSeq: 10,
    });
  });

  it("dedupes an entry whose id matches the last entry", () => {
    const before = ready([entry("e1", "message", 1)], 1);
    const [state, scroll] = foldLive(before, entryAppended(entry("e1", "message", 1)));
    expect(state).toEqual(before);
    expect(scroll).toBe(false);
  });

  it("treats two id-less entries as the same entry", () => {
    const before = ready([entry("", "message")]);
    const [state, scroll] = foldLive(before, entryAppended(entry("", "message")));
    expect(state).toEqual(before);
    expect(scroll).toBe(false);
  });

  it("is a no-op while the trail is loading", () => {
    const before = initialLive();
    const [state, scroll] = foldLive(before, entryAppended(entry("e1", "message", 1)));
    expect(state).toEqual(before);
    expect(scroll).toBe(false);
  });

  it("clears the streaming copy when a complete message entry lands", () => {
    const before = fold(
      ready(),
      messageStart("hi there"),
      messageUpdate([thinkingBlock("deep")]),
      toolStart("call_1", "bash"),
    );
    const [state, scroll] = foldLive(before, entryAppended(entry("e1", "message", 3)));
    expect(state.live.message).toBeUndefined();
    expect(state.live.thinking).toBeUndefined();
    // Tool activity and notices are not part of the message copy.
    expect(state.live.tools).toHaveLength(1);
    expect(state.trail).toEqual({
      _tag: "ready",
      entries: [entry("e1", "message", 3)],
      tailSeq: 3,
    });
    expect(scroll).toBe(true);
  });

  it("keeps the streaming copy for non-message entries", () => {
    const before = fold(ready(), messageStart("hi"));
    const [state, scroll] = foldLive(before, entryAppended(entry("e1", "toolResult", 2)));
    expect(state.live.message).toBe("hi");
    expect(state.trail).toEqual({
      _tag: "ready",
      entries: [entry("e1", "toolResult", 2)],
      tailSeq: 2,
    });
    expect(scroll).toBe(true);
  });

  it("hands the run off to the trail: stream, complete entry, next run", () => {
    const state = fold(
      ready(),
      messageStart("draft"),
      entryAppended(entry("e1", "message", 1)),
      messageStart("second run"),
      toolStart("call_1"),
      settled,
    );
    expect(state.trail).toEqual({
      _tag: "ready",
      entries: [entry("e1", "message", 1)],
      tailSeq: 1,
    });
    expect(state.live).toEqual({ tools: [] });
  });
});

// -- the settled transition -------------------------------------------------

describe("settled", () => {
  it("clears the whole live region and keeps the trail", () => {
    const before = fold(
      ready([entry("e1", "message", 1)], 1),
      messageStart("done"),
      toolStart("call_1"),
      compactionStart("manual"),
    );
    const [state, scroll] = foldLive(before, settled);
    expect(state.live).toEqual({ tools: [] });
    expect(state.trail).toEqual(before.trail);
    expect(scroll).toBe(false);
  });
});

// -- compaction and the unknown tail ----------------------------------------

describe("compaction and unknown events", () => {
  it("shows the compaction notice and clears it on completion", () => {
    const [started] = foldLive(initialLive(), compactionStart("manual"));
    expect(started.live.notice).toBe("compacting (manual)");
    const [finished] = foldLive(started, compactionEnd);
    expect(finished.live.notice).toBeUndefined();
  });

  it("carries every compaction reason into the notice", () => {
    expect(fold(initialLive(), compactionStart("threshold")).live.notice).toBe(
      "compacting (threshold)",
    );
    expect(fold(initialLive(), compactionStart("overflow")).live.notice).toBe(
      "compacting (overflow)",
    );
  });

  it("degrades unknown events to a no-op", () => {
    const before = fold(initialLive(), messageStart("hi"));
    const [state, scroll] = foldLive(before, unhandled);
    expect(state).toEqual(before);
    expect(scroll).toBe(false);
  });
});
