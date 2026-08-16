/**
 * Thread presentation tests (presentation.test.ts): the composer status
 * bar's pure derivations — the model badge label, the context-token decode
 * (pi's usage payloads), the trail's context usage, the 60/90 tone rule —
 * and the rail's pi-session filter (which sessions are not yet threads).
 * Exercised as properties, the house style.
 */

import { describe, expect, it } from "vitest";
import type { PiSessionInfo, ThreadInfo, WireModelInfo } from "@saku/wire";
import type { Arbitrary } from "fast-check";
import {
  array,
  assert,
  boolean,
  constant,
  constantFrom,
  integer,
  oneof,
  option,
  property,
  record,
  string,
} from "fast-check";
import type { EntryProjection } from "./thread/projection.ts";
import {
  CONTEXT_CRITICAL_PERCENT,
  CONTEXT_WARNING_PERCENT,
  contextTone,
  contextUsage,
  filterModels,
  modelLabel,
  unadoptedPiSessions,
  usageContextTokens,
  usageStatus,
} from "./presentation.ts";

const modelArb: Arbitrary<WireModelInfo> = record({
  contextWindow: integer({ min: 0 }),
  id: string({ maxLength: 24 }),
  provider: string({ maxLength: 12 }),
  reasoning: boolean(),
});

const messageArb = record({
  model: option(string({ maxLength: 24 }), { nil: undefined }),
  provider: option(string({ maxLength: 12 }), { nil: undefined }),
  role: constantFrom("user", "assistant", "toolResult"),
  stopReason: option(constantFrom("end_turn", "aborted", "error", "tool_use"), {
    nil: undefined,
  }),
  usage: option(
    record({
      cacheRead: integer({ min: 0 }),
      cacheWrite: integer({ min: 0 }),
      input: integer({ min: 0 }),
      totalTokens: option(integer({ min: 0 })),
    }),
    { nil: undefined },
  ),
});

const entryArb: Arbitrary<EntryProjection> = oneof(
  record({
    message: option(messageArb, { nil: undefined }),
    seq: option(integer({ min: 0 }), { nil: undefined }),
    type: constant("message"),
  }).map(({ message, ...rest }) => ({ ...rest, message })),
  record({
    seq: option(integer({ min: 0 }), { nil: undefined }),
    type: constant("compaction"),
  }),
  record({
    modelId: option(string({ maxLength: 24 }), { nil: undefined }),
    provider: option(string({ maxLength: 12 }), { nil: undefined }),
    seq: option(integer({ min: 0 }), { nil: undefined }),
    type: constant("model_change"),
  }),
  record({
    seq: option(integer({ min: 0 }), { nil: undefined }),
    thinkingLevel: option(string({ maxLength: 12 }), { nil: undefined }),
    type: constant("thinking_level_change"),
  }),
);

describe("modelLabel", () => {
  it("keeps ids that already carry the provider prefix, else joins them", () => {
    assert(
      property(string({ maxLength: 24 }), string({ maxLength: 24 }), (provider, id) => {
        const model = { contextWindow: 1, id, provider, reasoning: false };
        expect(modelLabel(model)).toBe(id.includes("/") ? id : `${provider}/${id}`);
      }),
    );
  });
});

describe("usageContextTokens", () => {
  it("prefers the native totalTokens, falls back to the component sum, and nulls on junk", () => {
    assert(
      property(
        integer({ min: 0 }),
        integer({ min: 0 }),
        integer({ min: 0 }),
        (input, cacheRead, cacheWrite) => {
          const withTotal = {
            cacheRead,
            cacheWrite,
            input,
            totalTokens: input + cacheRead + cacheWrite + 7,
          };
          expect(usageContextTokens(withTotal)).toBe(withTotal.totalTokens);
          const componentSum = { cacheRead, cacheWrite, input };
          expect(usageContextTokens(componentSum)).toBe(input + cacheRead + cacheWrite);
        },
      ),
    );
    expect(usageContextTokens(null)).toBeNull();
    expect(usageContextTokens("nope")).toBeNull();
    expect(usageContextTokens({})).toBeNull();
    expect(usageContextTokens({ cacheRead: 0, cacheWrite: 0, input: 0 })).toBeNull();
  });
});

describe("contextUsage", () => {
  it("is null without a model window, without usage, or after a compaction", () => {
    assert(
      property(modelArb, array(entryArb, { maxLength: 6 }), (model, entries) => {
        const usage = contextUsage(entries, model);
        const window = model.contextWindow;
        const lastAssistant = entries.findLast(
          (entry) =>
            entry.type === "message" &&
            entry.message !== undefined &&
            entry.message.role === "assistant" &&
            entry.message.stopReason !== "aborted" &&
            entry.message.stopReason !== "error" &&
            usageContextTokens(entry.message.usage) !== null,
        );
        const lastCompaction = entries.findLast((entry) => entry.type === "compaction");
        const unknown =
          window <= 0 ||
          lastAssistant === undefined ||
          (lastCompaction !== undefined && (lastCompaction.seq ?? -1) > (lastAssistant.seq ?? -1));
        if (unknown) {
          expect(usage).toBeNull();
        } else {
          expect(usage).not.toBeNull();
          if (usage === null) {
            throw new Error("expected usage to be present");
          }
          if (lastAssistant === undefined || lastAssistant.message === undefined) {
            throw new Error("expected a last assistant message");
          }
          expect(usage.window).toBe(window);
          expect(usage.tokens).toBe(usageContextTokens(lastAssistant.message.usage));
          expect(usage.percent).toBe(Math.round((usage.tokens / window) * 100));
        }
      }),
    );
  });

  it("compaction entries without any assistant usage leave the badge unknown", () => {
    expect(
      contextUsage([{ type: "compaction" }], {
        contextWindow: 100,
        id: "m",
        provider: "p",
        reasoning: false,
      }),
    ).toBeNull();
    expect(
      contextUsage([], { contextWindow: 100, id: "m", provider: "p", reasoning: false }),
    ).toBeNull();
  });
});

describe("contextTone", () => {
  it("is foam below the warning, gold at it, love at the critical threshold", () => {
    expect(contextTone(CONTEXT_WARNING_PERCENT - 1)).toBe("text-foam");
    expect(contextTone(CONTEXT_WARNING_PERCENT)).toBe("text-gold");
    expect(contextTone(CONTEXT_CRITICAL_PERCENT - 1)).toBe("text-gold");
    expect(contextTone(CONTEXT_CRITICAL_PERCENT)).toBe("text-love");
    expect(contextTone(100)).toBe("text-love");
  });
});

describe("usageStatus", () => {
  const windowModel: WireModelInfo = {
    contextWindow: 1000,
    id: "thread-model",
    provider: "thread-provider",
    reasoning: false,
  };
  const usage = { cacheRead: 200, cacheWrite: 10, input: 100, output: 50, totalTokens: 310 };

  it("is unknown exactly when contextUsage is (the same trail rule)", () => {
    assert(
      property(modelArb, array(entryArb, { maxLength: 6 }), (model, entries) => {
        const status = usageStatus(entries, model);
        const expected = contextUsage(entries, model);
        expect(status === null).toBe(expected === null);
        if (status !== null && expected !== null) {
          expect(status.context).toEqual(expected);
        }
      }),
    );
  });

  it("breaks the last response's usage into in/out/cached with a hit rate", () => {
    const status = usageStatus(
      [
        { modelId: "old", provider: "p", seq: 0, type: "model_change" },
        { seq: 1, thinkingLevel: "low", type: "thinking_level_change" },
        {
          message: {
            model: "new-model",
            provider: "anthropic",
            role: "assistant",
            stopReason: "end_turn",
            usage,
          },
          seq: 2,
          type: "message",
        },
      ],
      windowModel,
    );
    expect(status).toEqual({
      cacheHitRate: 200 / 300,
      cacheRead: 200,
      context: { percent: 31, tokens: 310, window: 1000 },
      input: 100,
      model: { id: "new-model", provider: "anthropic" },
      output: 50,
      thinkingLevel: "low",
    });
  });

  it("falls back to the last model_change for the model, then the thread's", () => {
    const fromChange = usageStatus(
      [
        { modelId: "old-model", provider: "anthropic", seq: 0, type: "model_change" },
        { message: { role: "assistant", usage }, seq: 1, type: "message" },
      ],
      windowModel,
    );
    expect(fromChange?.model).toEqual({ id: "old-model", provider: "anthropic" });
    const fromThread = usageStatus(
      [{ message: { role: "assistant", usage }, seq: 0, type: "message" }],
      windowModel,
    );
    expect(fromThread?.model).toEqual({ id: "thread-model", provider: "thread-provider" });
  });

  it("uses the thinking level in effect at the message, not a later change", () => {
    const status = usageStatus(
      [
        { seq: 0, thinkingLevel: "low", type: "thinking_level_change" },
        { message: { role: "assistant", usage }, seq: 1, type: "message" },
        { seq: 2, thinkingLevel: "high", type: "thinking_level_change" },
      ],
      windowModel,
    );
    expect(status?.thinkingLevel).toBe("low");
  });

  it("has no hit rate when the response had no input tokens at all", () => {
    const status = usageStatus(
      [
        {
          message: {
            role: "assistant",
            usage: { cacheRead: 0, cacheWrite: 0, input: 0, output: 5, totalTokens: 5 },
          },
          seq: 0,
          type: "message",
        },
      ],
      windowModel,
    );
    expect(status?.cacheHitRate).toBeNull();
    expect(status?.output).toBe(5);
  });

  it("falls back to the latest thinking level when no change preceded the message", () => {
    expect(
      usageStatus(
        [
          { message: { role: "assistant", usage }, seq: 0, type: "message" },
          { seq: 1, thinkingLevel: "max", type: "thinking_level_change" },
        ],
        windowModel,
      )?.thinkingLevel,
    ).toBe("max");
  });
});

describe("filterModels", () => {
  const fixed = [
    { contextWindow: 128_000, id: "gpt-4o", provider: "openai", reasoning: false },
    { contextWindow: 200_000, id: "claude-3-7-sonnet", provider: "anthropic", reasoning: true },
    { contextWindow: 1_000_000, id: "gemini/2.5-pro", provider: "opencode-go", reasoning: true },
  ] as const satisfies readonly WireModelInfo[];

  it("returns everything, in catalog order, for an empty or blank query", () => {
    expect(filterModels(fixed, "")).toEqual(fixed);
    expect(filterModels(fixed, "   ")).toEqual(fixed);
  });

  it("matches the id, the provider, and the joined label, case-insensitively", () => {
    expect(filterModels(fixed, "GPT-4")).toEqual([fixed[0]]);
    // The id carries a prefix here, so the provider is only reachable via
    // the provider field, not the label.
    expect(filterModels(fixed, "opencode")).toEqual([fixed[2]]);
    expect(filterModels(fixed, "gemini/2.5")).toEqual([fixed[2]]);
    expect(filterModels(fixed, "sonnet")).toEqual([fixed[1]]);
  });

  it("no match yields an empty list", () => {
    expect(filterModels(fixed, "llama")).toEqual([]);
  });

  it("is a subsequence of the input for any query (order preserved)", () => {
    assert(
      property(array(modelArb, { maxLength: 6 }), string({ maxLength: 12 }), (models, query) => {
        const kept = filterModels(models, query);
        const positions = kept.map((keptModel) => models.indexOf(keptModel));
        expect(positions).toEqual([...positions].toSorted((a, b) => a - b));
        expect(positions).not.toContain(-1);
      }),
    );
  });
});

const piSessionArb: Arbitrary<PiSessionInfo> = record({
  createdAt: integer(),
  cwd: string({ maxLength: 24 }),
  firstMessage: string({ maxLength: 24 }),
  id: string({ maxLength: 24 }),
  messageCount: integer({ min: 0 }),
  modifiedAt: integer(),
  name: string({ maxLength: 24 }),
  path: string({ maxLength: 24 }),
});

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

describe("unadoptedPiSessions", () => {
  it("keeps every session when no thread is adopted from pi", () => {
    assert(
      property(
        array(threadArb, { maxLength: 4 }),
        array(piSessionArb, { maxLength: 4 }),
        (threads, sessions) => {
          const kept = unadoptedPiSessions(threads, sessions);
          // A session path can only be claimed by a thread whose source is pi.
          expect(kept).toHaveLength(sessions.length);
          expect(new Set(kept.map((session) => session.path))).toEqual(
            new Set(sessions.map((session) => session.path)),
          );
        },
      ),
    );
  });

  it("drops exactly the sessions some adopted thread pins, keeping order", () => {
    assert(
      property(
        array(piSessionArb, { maxLength: 4 }),
        string({ maxLength: 24 }),
        (sessions, threadId) => {
          const threads: ThreadInfo[] = sessions.map((session, index) => ({
            archivedAt: null,
            cwd: session.cwd,
            env: "stopped" as const,
            id: `${threadId}${index}`,
            mode: "local" as const,
            name: `adopted ${index}`,
            sessionId: session.id,
            source: { kind: "pi", path: session.path, sessionId: session.id },
            state: "idle" as const,
            tailSeq: 0,
          }));
          const kept = unadoptedPiSessions(threads, sessions);
          expect(kept).toEqual([]);
        },
      ),
    );
  });

  it("a session adopted twice stays dropped once (the filter is a set membership)", () => {
    assert(
      property(piSessionArb, string({ maxLength: 24 }), (session, threadId) => {
        const duplicate: ThreadInfo = {
          archivedAt: null,
          cwd: null,
          env: "stopped",
          id: threadId,
          mode: "local",
          name: "dup",
          sessionId: null,
          source: { kind: "pi", path: session.path, sessionId: session.id },
          state: "idle",
          tailSeq: 0,
        };
        expect(unadoptedPiSessions([duplicate, duplicate], [session])).toEqual([]);
      }),
    );
  });
});
