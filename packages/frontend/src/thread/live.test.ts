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
import { Schema as S } from "effect";
import { AsyncData } from "foldkit";
import type { Arbitrary, JsonValue } from "fast-check";
import {
  array,
  assert,
  boolean,
  constant,
  constantFrom,
  integer,
  jsonValue,
  oneof,
  option,
  pre,
  property,
  record,
  string,
  uniqueArray,
} from "fast-check";
import { emptyLiveRegion, foldLive, foldTrailLoaded, Trail } from "./live.ts";
import type { Live } from "./live.ts";
import type { EntryProjection, SessionEventProjection } from "./projection.ts";

/** The fold's initial state: trail idle, nothing streamed or buffered. */
const initial = () => ({ live: emptyLiveRegion(), pending: [], trail: Trail.Idle() });

/** The single tool row of the captured-args test, failing when absent. */
const toolRow = (state: Live) => {
  const [row] = state.live.tools;
  if (row === undefined) {
    throw new Error("expected tool c1");
  }
  return row;
};

/** A message content block, typed structurally (the projection's ContentBlock). */
interface ContentBlock {
  readonly text?: string | undefined;
  readonly thinking?: string | undefined;
  readonly type?: string | undefined;
}

/** A message's content: a plain string or a block list (the projection's union). */
type MessageContent = string | readonly ContentBlock[] | undefined;

/** Any payload a tool update/end could carry: absent, a string, or JSON.
 * Typed as the projection's own payload type (effect's `Json`) so the
 * emitted tool events are directly foldable. */
type ToolPayload = Extract<
  SessionEventProjection,
  { readonly _tag: "tool_execution_update" }
>["partialResult"];

const isString = <T>(value: T): value is Extract<T, string> => typeof value === "string";

const isBlocks = (content: MessageContent): content is readonly ContentBlock[] =>
  Array.isArray(content);

/** The defensive id cast, re-derived: absent ids compare equal. */
const idOf = (id: string | undefined) => (isString(id) ? id : "");

/** The joined text content of a message, re-derived from the module contract. */
const textOf = (content: MessageContent): string => {
  if (isString(content)) {
    return content;
  }
  if (isBlocks(content)) {
    return content
      .map((block) => (block.type === "text" && isString(block.text) ? block.text : ""))
      .join("")
      .trim();
  }
  return "";
};

/** The joined thinking content of a message, re-derived from the module contract. */
const thinkingOf = (content: MessageContent): string => {
  if (!isBlocks(content)) {
    return "";
  }
  return content
    .map((block) => (block.type === "thinking" && isString(block.thinking) ? block.thinking : ""))
    .join("")
    .trim();
};

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const entryArb: Arbitrary<EntryProjection> = record({
  id: option(string({ maxLength: 12 }), { nil: undefined }),
  seq: option(integer(), { nil: undefined }),
  type: option(constantFrom("message", "toolResult", "user_message"), { nil: undefined }),
});

const trailArb: Arbitrary<Live["trail"]> = oneof(
  constant(Trail.Idle()),
  record({ entries: array(entryArb, { maxLength: 4 }), tailSeq: integer() }).map((data) =>
    Trail.Success({ data }),
  ),
  constant(Trail.Failure({ error: "boom" })),
);

const liveArb: Arbitrary<Live["live"]> = record({
  message: option(string({ maxLength: 24 }), { nil: undefined }),
  notice: option(string({ maxLength: 24 }), { nil: undefined }),
  thinking: option(string({ maxLength: 24 }), { nil: undefined }),
  tools: array(
    record({
      callId: string({ maxLength: 12 }),
      name: string({ maxLength: 12 }),
      state: constantFrom("running", "done", "failed"),
    }),
    { maxLength: 3 },
  ),
});

const stateArb: Arbitrary<Live> = record({
  live: liveArb,
  pending: array(entryArb, { maxLength: 3 }),
  trail: trailArb,
});

const blockArb = record({
  text: option(string({ maxLength: 24 }), { nil: undefined }),
  thinking: option(string({ maxLength: 24 }), { nil: undefined }),
  type: option(constantFrom("text", "thinking", "toolCall"), { nil: undefined }),
});

const contentArb = oneof(string({ maxLength: 24 }), array(blockArb, { maxLength: 4 }));

const messageEventArb = oneof(
  record({
    _tag: constant("message_start" as const),
    message: record({ content: option(contentArb, { nil: undefined }) }),
  }),
  record({
    _tag: constant("message_update" as const),
    message: record({ content: option(contentArb, { nil: undefined }) }),
  }),
  record({
    _tag: constant("message_end" as const),
    message: record({ content: option(contentArb, { nil: undefined }) }),
  }),
);

/** A JSON value JSON text can round-trip losslessly (no `-0`, which
 * `JSON.stringify` renders as `"0"`). The wire's display contract is the
 * JSON text round-trip, so such payloads are outside its domain. */
const isLosslessJson = (value: JsonValue | undefined): value is JsonValue => {
  if (value === undefined) {
    return false;
  }
  if (typeof value === "number") {
    return !Object.is(value, -0);
  }
  if (Array.isArray(value)) {
    return value.every(isLosslessJson);
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).every(isLosslessJson);
  }
  return true;
};

/** Any payload a tool update/end could carry, within the lossless display budget. */
const payloadArb: Arbitrary<ToolPayload> = oneof(
  string({ maxLength: 100 }),
  // fast-check's JsonValue is its own type; the projection's payload type is
  // effect's Json — the schema decode is the boundary between them. Values
  // JSON cannot round-trip losslessly (-0) are excluded up front.
  jsonValue({ maxDepth: 2 })
    .filter(isLosslessJson)
    .map((value) => S.decodeUnknownSync(S.Json)(value)),
);

interface ToolRun {
  readonly callId: string;
  readonly name: string;
  readonly updates: readonly ToolPayload[];
  readonly end: { readonly result: ToolPayload; readonly isError: boolean } | undefined;
}

const toolRunArb: Arbitrary<ToolRun> = record({
  callId: string({ maxLength: 4, minLength: 1 }),
  end: option(record({ isError: boolean(), result: payloadArb }), { nil: undefined }),
  name: string({ maxLength: 16 }),
  updates: array(payloadArb, { maxLength: 3 }),
});

/** The event stream a set of tool runs produces (start, updates, end). */
const toolEvents = (runs: readonly ToolRun[]) =>
  runs.flatMap((run) => [
    { _tag: "tool_execution_start" as const, toolCallId: run.callId, toolName: run.name },
    ...run.updates.map((partialResult) => ({
      _tag: "tool_execution_update" as const,
      partialResult,
      toolCallId: run.callId,
    })),
    ...(run.end === undefined
      ? []
      : [
          {
            _tag: "tool_execution_end" as const,
            isError: run.end.isError,
            result: run.end.result,
            toolCallId: run.callId,
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
  aborted: false,
  reason: "manual",
};
const unhandled: SessionEventProjection = {
  _tag: "unhandled",
  event: { type: "some_future_event" },
};

describe("message stream", () => {
  it("folds any message stream with last-write-wins, empty-preserves semantics", () => {
    assert(
      property(stateArb, array(messageEventArb, { maxLength: 8 }), (state, events) => {
        let current = state;
        let { message } = current.live;
        let { thinking } = current.live;
        for (const event of events) {
          const next = foldLive(current, event);
          expect(next.trail).toEqual(current.trail);
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
          current = next;
        }
      }),
    );
  });
});

describe("tool execution", () => {
  it("tracks parallel tools per call id, last event wins, display is lossless", () => {
    assert(
      property(uniqueArray(toolRunArb, { maxLength: 4, selector: (run) => run.callId }), (runs) => {
        let state: Live = initial();
        for (const event of toolEvents(runs)) {
          state = foldLive(state, event);
        }
        // One row per run, in start order.
        expect(state.live.tools.map((tool) => tool.callId)).toEqual(runs.map((run) => run.callId));
        for (let i = 0; i < runs.length; i += 1) {
          const run = runs[i];
          const row = state.live.tools[i];
          if (run === undefined || row === undefined) {
            throw new Error(`expected a tool row at ${i}`);
          }
          // The name is pinned at start.
          expect(row.name).toBe(run.name);
          if (run.end === undefined) {
            expect(row.state).toBe("running");
            expect(row.result).toBeUndefined();
          } else {
            expect(row.state).toBe(run.end.isError ? "failed" : "done");
            if (isString(run.end.result)) {
              expect(row.result).toBe(run.end.result);
            } else {
              pre(run.end.result !== undefined && JSON.stringify(run.end.result).length <= 400);
              expect(JSON.parse(row.result ?? "")).toEqual(run.end.result);
            }
          }
          // The partial is the last update's payload, displayed losslessly;
          // absent when no update ever landed. A landed update with an
          // undefined payload displays as the empty string.
          if (run.updates.length === 0) {
            expect(row.partial).toBeUndefined();
          } else {
            const lastUpdate = run.updates.at(-1);
            if (lastUpdate === undefined) {
              expect(row.partial).toBe("");
            } else if (isString(lastUpdate)) {
              expect(row.partial).toBe(lastUpdate);
            } else {
              pre(JSON.stringify(lastUpdate).length <= 400);
              expect(JSON.parse(row.partial ?? "")).toEqual(lastUpdate);
            }
          }
        }
      }),
    );
  });

  it("captures the tool's args: start pins them, a streamed update refreshes", () => {
    let state: Live = initial();
    state = foldLive(state, {
      _tag: "tool_execution_start",
      args: { command: "ls" },
      toolCallId: "c1",
      toolName: "bash",
    });
    expect(toolRow(state).args).toEqual({ command: "ls" });
    // An update without args keeps the start's args.
    state = foldLive(state, {
      _tag: "tool_execution_update",
      partialResult: "…",
      toolCallId: "c1",
    });
    expect(toolRow(state).args).toEqual({ command: "ls" });
    // An update with args refreshes them (pi streams the accumulating args).
    state = foldLive(state, {
      _tag: "tool_execution_update",
      args: { command: "ls -la" },
      partialResult: "…",
      toolCallId: "c1",
    });
    expect(toolRow(state).args).toEqual({ command: "ls -la" });
    // The args survive the end event.
    state = foldLive(state, {
      _tag: "tool_execution_end",
      isError: false,
      result: "total 0",
      toolCallId: "c1",
    });
    expect(toolRow(state).args).toEqual({ command: "ls -la" });
  });

  it("leaves the tools untouched for an unknown call id", () => {
    assert(
      property(
        stateArb,
        string({ maxLength: 6, minLength: 1 }),
        boolean(),
        (state, callId, isError) => {
          // The call id must not collide with a run already in the state —
          // the fold would target that run instead of staying untouched.
          pre(!state.live.tools.some((tool) => tool.callId === callId));
          const updated = foldLive(state, {
            _tag: "tool_execution_update",
            partialResult: "x",
            toolCallId: callId,
          });
          expect(updated).toEqual(state);
          const ended = foldLive(state, {
            _tag: "tool_execution_end",
            isError,
            result: "y",
            toolCallId: callId,
          });
          expect(ended).toEqual(state);
        },
      ),
    );
  });
});

describe("entry_appended", () => {
  it("grows the trail, bumps tailSeq, and dedupes against the last entry", () => {
    assert(
      property(
        record({
          entries: array(entryArb, { maxLength: 4 }),
          tailSeq: integer(),
        }),
        liveArb,
        entryArb,
        (data, live, incoming) => {
          const state: Live = { live, pending: [], trail: Trail.Success({ data }) };
          const next = foldLive(state, entryAppended(incoming));
          const last = data.entries.at(-1);
          // A replayed seq (the catch-up read already delivered it) dedupes
          // just like an identical last id does.
          const replayed = incoming.seq !== undefined && incoming.seq <= data.tailSeq;
          const same = (last !== undefined && idOf(last.id) === idOf(incoming.id)) || replayed;
          if (same) {
            expect(next).toEqual(state);
          } else {
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

  it("buffers appends while the trail is not loaded, then merges at load", () => {
    assert(
      property(
        oneof(constant(Trail.Idle()), constant(Trail.Failure({ error: "boom" }))),
        array(entryArb, { maxLength: 4 }),
        (trail, incoming) => {
          // Nothing is lost while loading: every append lands in the buffer.
          let state: Live = { live: emptyLiveRegion(), pending: [], trail };
          for (const entry of incoming) {
            state = foldLive(state, entryAppended(entry));
          }
          expect(state.pending).toEqual(incoming);
          expect(state.trail).toEqual(trail);

          // The read lands (empty from the server): the buffer merges in,
          // deduped by id and ordered by seq, tailSeq never lowering.
          const loaded = foldTrailLoaded(state, [], 0);
          expect(loaded.pending).toEqual([]);
          if (!AsyncData.isSuccess(loaded.trail)) {
            throw new Error("expected the merged trail to be Success");
          }
          expect(loaded.trail.data.entries).toHaveLength(
            new Set(incoming.map((entry) => idOf(entry.id))).size,
          );
        },
      ),
    );
  });

  it("never lowers tailSeq across a stream of appends", () => {
    assert(
      property(array(entryArb, { maxLength: 10 }), integer(), (entries, startSeq) => {
        let state: Live = {
          live: emptyLiveRegion(),
          pending: [],
          trail: Trail.Success({ data: { entries: [], tailSeq: startSeq } }),
        };
        let previous = startSeq;
        for (const entry of entries) {
          const next = foldLive(state, entryAppended(entry));
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
    assert(
      property(stateArb, (state) => {
        const next = foldLive(state, { _tag: "settled" });
        expect(next.live).toEqual({ tools: [] });
        expect(next.trail).toEqual(state.trail);
      }),
    );
  });

  it("shows the compaction notice per reason and clears it on completion", () => {
    assert(
      property(
        stateArb,
        constantFrom("manual" as const, "threshold" as const, "overflow" as const),
        (state, reason) => {
          const started = foldLive(state, compactionStart(reason));
          expect(started.live.notice).toBe(`compacting (${reason})`);
          const finished = foldLive(started, compactionEnd);
          expect(finished.live.notice).toBeUndefined();
        },
      ),
    );
  });

  it("degrades unknown events to a no-op", () => {
    assert(
      property(stateArb, (state) => {
        const next = foldLive(state, unhandled);
        expect(next).toEqual(state);
      }),
    );
  });

  it("trail load merges server entries and the buffer without loss", () => {
    assert(
      property(
        array(entryArb, { maxLength: 4 }),
        array(entryArb, { maxLength: 4 }),
        integer(),
        (serverEntries, buffered, tailSeq) => {
          const state: Live = {
            live: emptyLiveRegion(),
            pending: buffered,
            trail: Trail.Idle(),
          };
          const loaded = foldTrailLoaded(state, serverEntries, tailSeq);
          expect(loaded.pending).toEqual([]);
          if (!AsyncData.isSuccess(loaded.trail)) {
            throw new Error("expected Success");
          }
          const merged = loaded.trail.data.entries;
          // No loss, server's copy wins collisions: the distinct id set is
          // exactly the union of both sides' ids.
          const ids = new Set(merged.map((entry) => idOf(entry.id)));
          const expectedDistinct = new Set(
            [...serverEntries, ...buffered].map((entry) => idOf(entry.id)),
          ).size;
          expect(ids.size).toBe(expectedDistinct);
          // Ordered by seq (unknown seqs last), and tailSeq never lowers.
          const seqs = merged.map((entry) => entry.seq ?? Number.MAX_SAFE_INTEGER);
          expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
          expect(loaded.trail.data.tailSeq).toBeGreaterThanOrEqual(tailSeq);
        },
      ),
    );
  });
});
