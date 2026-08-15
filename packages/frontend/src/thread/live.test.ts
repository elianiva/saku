/**
 * The live fold's property tests (live.test.ts): the streaming fold —
 * message_start/update/end, tool_execution_*, the complete-entry-clears-
 * streaming-copy invariant, entry_appended during loading, dedupe, and the
 * settled reset — exercised as pure functions over generated event streams.
 * No foldkit runtime, no DOM, no wire service.
 *
 * The properties pin the fold's contracts over arbitrary inputs: message
 * events are last-write-wins per field with empty updates preserving the
 * stream (start/end always set), tool rows track per call id with the name
 * pinned at start and unknown ids ignored, the displayed partials/results
 * are lossless for payloads within the display budget, and every
 * entry_appended either dedupes against the last entry or grows the trail
 * with a never-lowering tailSeq. Content extraction (text vs thinking) is
 * re-derived here from the module contract, independently of format.ts.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { emptyLiveRegion, foldLive, Trail, type Live } from "./live.ts";
import type { EntryProjection, MessageProjection, SessionEventProjection } from "./projection.ts";

/** The fold's initial state: trail idle, nothing streamed. */
const initial = () => ({ trail: Trail.Idle(), live: emptyLiveRegion() });

/** The defensive id cast, re-derived: absent ids compare equal. */
const idOf = (id: string | undefined) => (typeof id === "string" ? id : "");

/** The joined text content of a message, re-derived from the module contract. */
const textOf = (content: MessageProjection["content"]): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
      .join("")
      .trim();
  }
  return "";
};

/** The joined thinking content of a message, re-derived from the module contract. */
const thinkingOf = (content: MessageProjection["content"]): string => {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block.type === "thinking" && typeof block.thinking === "string" ? block.thinking : "",
    )
    .join("")
    .trim();
};

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const entryArb: fc.Arbitrary<EntryProjection> = fc.record({
  id: fc.option(fc.string({ maxLength: 12 }), { nil: undefined }),
  seq: fc.option(fc.integer(), { nil: undefined }),
  type: fc.option(fc.constantFrom("message", "toolResult", "user_message"), { nil: undefined }),
});

const trailArb: fc.Arbitrary<Live["trail"]> = fc.oneof(
  fc.constant(Trail.Idle()),
  fc
    .record({ entries: fc.array(entryArb, { maxLength: 4 }), tailSeq: fc.integer() })
    .map((data) => Trail.Success({ data })),
  fc.constant(Trail.Failure({ error: "boom" })),
);

const liveArb: fc.Arbitrary<Live["live"]> = fc.record({
  message: fc.option(fc.string({ maxLength: 24 }), { nil: undefined }),
  thinking: fc.option(fc.string({ maxLength: 24 }), { nil: undefined }),
  tools: fc.array(
    fc.record({
      callId: fc.string({ maxLength: 12 }),
      name: fc.string({ maxLength: 12 }),
      state: fc.constantFrom("running", "done", "failed"),
    }),
    { maxLength: 3 },
  ),
  notice: fc.option(fc.string({ maxLength: 24 }), { nil: undefined }),
});

const stateArb: fc.Arbitrary<Live> = fc.record({ trail: trailArb, live: liveArb });

const blockArb = fc.record({
  type: fc.option(fc.constantFrom("text", "thinking", "toolCall"), { nil: undefined }),
  text: fc.option(fc.string({ maxLength: 24 }), { nil: undefined }),
  thinking: fc.option(fc.string({ maxLength: 24 }), { nil: undefined }),
});

const contentArb = fc.oneof(
  fc.string({ maxLength: 24 }),
  fc.array(blockArb, { maxLength: 4 }),
);

const messageEventArb = fc.oneof(
  fc
    .record({
      _tag: fc.constant("message_start" as const),
      message: fc.record({ content: fc.option(contentArb, { nil: undefined }) }),
    }),
  fc
    .record({
      _tag: fc.constant("message_update" as const),
      message: fc.record({ content: fc.option(contentArb, { nil: undefined }) }),
    }),
  fc
    .record({
      _tag: fc.constant("message_end" as const),
      message: fc.record({ content: fc.option(contentArb, { nil: undefined }) }),
    }),
);

/** Any payload a tool update/end could carry, within the lossless display budget. */
const payloadArb = fc.oneof(
  fc.constant(undefined),
  fc.string({ maxLength: 100 }),
  fc.jsonValue({ maxDepth: 2 }),
);

interface ToolRun {
  readonly callId: string;
  readonly name: string;
  readonly updates: readonly unknown[];
  readonly end: { readonly result: unknown; readonly isError: boolean } | undefined;
}

const toolRunArb: fc.Arbitrary<ToolRun> = fc.record({
  callId: fc.string({ minLength: 1, maxLength: 4 }),
  name: fc.string({ maxLength: 16 }),
  updates: fc.array(payloadArb, { maxLength: 3 }),
  end: fc.option(
    fc.record({ result: payloadArb, isError: fc.boolean() }),
    { nil: undefined },
  ),
});

/** The event stream a set of tool runs produces (start, updates, end). */
const toolEvents = (runs: readonly ToolRun[]) =>
  runs.flatMap((run) => [
    { _tag: "tool_execution_start" as const, toolCallId: run.callId, toolName: run.name },
    ...run.updates.map((partialResult) => ({
      _tag: "tool_execution_update" as const,
      toolCallId: run.callId,
      partialResult,
    })),
    ...(run.end === undefined
      ? []
      : [
          {
            _tag: "tool_execution_end" as const,
            toolCallId: run.callId,
            result: run.end.result,
            isError: run.end.isError,
          },
        ]),
  ]);

const entryAppended = (entry: EntryProjection) => ({
  _tag: "entry_appended" as const,
  entry,
});
const compactionStart = (reason: "manual" | "threshold" | "overflow") => ({
  _tag: "compaction_start" as const,
  reason,
});
const compactionEnd: SessionEventProjection = {
  _tag: "compaction_end",
  reason: "manual",
  aborted: false,
};
const unhandled: SessionEventProjection = {
  _tag: "unhandled",
  event: { type: "some_future_event" },
};

describe("message stream", () => {
  it("folds any message stream with last-write-wins, empty-preserves semantics", () => {
    fc.assert(
      fc.property(stateArb, fc.array(messageEventArb, { maxLength: 8 }), (state, events) => {
        let message = state.live.message;
        let thinking = state.live.thinking;
        for (const event of events) {
          const [next, scroll] = foldLive(state, event);
          expect(scroll).toBe(true);
          expect(next.trail).toEqual(state.trail);
          const text = textOf(event.message.content);
          const think = thinkingOf(event.message.content);
          if (event._tag === "message_update") {
            message = text === "" ? message : text;
            thinking = think === "" ? thinking : think;
          } else {
            // start/end replace the message body and leave thinking alone.
            message = text;
          }
          expect(next.live.message).toBe(message);
          expect(next.live.thinking).toBe(thinking);
          state = next;
        }
      }),
    );
  });
});

describe("tool execution", () => {
  it("tracks parallel tools per call id, last event wins, display is lossless", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(toolRunArb, { maxLength: 4, selector: (run) => run.callId }),
        (runs) => {
          let state: Live = initial();
          for (const event of toolEvents(runs)) {
            const [next, scroll] = foldLive(state, event);
            expect(scroll).toBe(false);
            state = next;
          }
          // One row per run, in start order.
          expect(state.live.tools.map((tool) => tool.callId)).toEqual(
            runs.map((run) => run.callId),
          );
          for (let i = 0; i < runs.length; i++) {
            const run = runs[i]!;
            const row = state.live.tools[i]!;
            // The name is pinned at start.
            expect(row.name).toBe(run.name);
            if (run.end === undefined) {
              expect(row.state).toBe("running");
              expect(row.result).toBeUndefined();
            } else {
              expect(row.state).toBe(run.end.isError ? "failed" : "done");
              if (typeof run.end.result === "string") {
                expect(row.result).toBe(run.end.result);
              } else {
                fc.pre(
                  run.end.result !== undefined &&
                    JSON.stringify(run.end.result).length <= 400,
                );
                expect(JSON.parse(row.result ?? "")).toEqual(run.end.result);
              }
            }
            // The partial is the last update's payload, displayed losslessly;
            // absent when no update ever landed. A landed update with an
            // undefined payload displays as the empty string.
            if (run.updates.length === 0) {
              expect(row.partial).toBeUndefined();
            } else {
              const lastUpdate = run.updates[run.updates.length - 1]!;
              if (lastUpdate === undefined) {
                expect(row.partial).toBe("");
              } else if (typeof lastUpdate === "string") {
                expect(row.partial).toBe(lastUpdate);
              } else {
                fc.pre(JSON.stringify(lastUpdate).length <= 400);
                expect(JSON.parse(row.partial ?? "")).toEqual(lastUpdate);
              }
            }
          }
        },
      ),
    );
  });

  it("leaves the tools untouched for an unknown call id", () => {
    fc.assert(
      fc.property(stateArb, fc.string({ minLength: 1, maxLength: 6 }), fc.boolean(), (state, callId, isError) => {
        const updated = foldLive(state, {
          _tag: "tool_execution_update",
          toolCallId: callId,
          partialResult: "x",
        })[0];
        expect(updated).toEqual(state);
        const ended = foldLive(state, {
          _tag: "tool_execution_end",
          toolCallId: callId,
          isError,
          result: "y",
        })[0];
        expect(ended).toEqual(state);
      }),
    );
  });
});

describe("entry_appended", () => {
  it("grows the trail, bumps tailSeq, and dedupes against the last entry", () => {
    fc.assert(
      fc.property(
        fc.record({
          entries: fc.array(entryArb, { maxLength: 4 }),
          tailSeq: fc.integer(),
        }),
        liveArb,
        entryArb,
        (data, live, incoming) => {
          const state: Live = { trail: Trail.Success({ data }), live };
          const [next, scroll] = foldLive(state, entryAppended(incoming));
          const last = data.entries[data.entries.length - 1];
          const same = last !== undefined && idOf(last.id) === idOf(incoming.id);
          if (same) {
            expect(next).toEqual(state);
            expect(scroll).toBe(false);
          } else {
            expect(scroll).toBe(true);
            expect(next.trail).toEqual(
              Trail.Success({
                data: {
                  entries: [...data.entries, incoming],
                  tailSeq: Math.max(data.tailSeq, incoming.seq ?? 0),
                },
              }),
            );
            // A complete message entry clears the streaming copy; anything
            // else keeps it.
            if (incoming.type === "message") {
              expect(next.live.message).toBeUndefined();
              expect(next.live.thinking).toBeUndefined();
              expect(next.live.tools).toEqual(state.live.tools);
            } else {
              expect(next.live).toEqual(state.live);
            }
          }
        },
      ),
    );
  });

  it("is a no-op while the trail is not loaded", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(Trail.Idle()), fc.constant(Trail.Failure({ error: "boom" }))),
        entryArb,
        (trail, incoming) => {
          const state: Live = { trail, live: emptyLiveRegion() };
          const [next, scroll] = foldLive(state, entryAppended(incoming));
          expect(next).toEqual(state);
          expect(scroll).toBe(false);
        },
      ),
    );
  });

  it("never lowers tailSeq across a stream of appends", () => {
    fc.assert(
      fc.property(fc.array(entryArb, { maxLength: 10 }), fc.integer(), (entries, startSeq) => {
        let state: Live = {
          trail: Trail.Success({ data: { entries: [], tailSeq: startSeq } }),
          live: emptyLiveRegion(),
        };
        let previous = startSeq;
        for (const entry of entries) {
          const [next] = foldLive(state, entryAppended(entry));
          if (next.trail._tag === "Success") {
            expect(next.trail.data.tailSeq).toBeGreaterThanOrEqual(previous);
            previous = next.trail.data.tailSeq;
          }
          state = next;
        }
      }),
    );
  });
});

describe("settled, compaction, and unknown events", () => {
  it("settled clears the whole live region and keeps the trail", () => {
    fc.assert(
      fc.property(stateArb, (state) => {
        const [next, scroll] = foldLive(state, { _tag: "settled" });
        expect(next.live).toEqual({ tools: [] });
        expect(next.trail).toEqual(state.trail);
        expect(scroll).toBe(false);
      }),
    );
  });

  it("shows the compaction notice per reason and clears it on completion", () => {
    fc.assert(
      fc.property(
        stateArb,
        fc.constantFrom("manual" as const, "threshold" as const, "overflow" as const),
        (state, reason) => {
          const [started, startScroll] = foldLive(state, compactionStart(reason));
          expect(started.live.notice).toBe(`compacting (${reason})`);
          expect(startScroll).toBe(false);
          const [finished, endScroll] = foldLive(started, compactionEnd);
          expect(finished.live.notice).toBeUndefined();
          expect(endScroll).toBe(false);
        },
      ),
    );
  });

  it("degrades unknown events to a no-op", () => {
    fc.assert(
      fc.property(stateArb, (state) => {
        const [next, scroll] = foldLive(state, unhandled);
        expect(next).toEqual(state);
        expect(scroll).toBe(false);
      }),
    );
  });
});
