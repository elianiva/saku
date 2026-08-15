/**
 * Thread presentation tests (presentation.test.ts): the composer status
 * bar's pure derivations — the model badge label, the context-token decode
 * (pi's usage payloads), the trail's context usage, the 60/90 tone rule —
 * and the rail's pi-session filter (which sessions are not yet threads).
 * Exercised as properties, the house style.
 */

import { describe, expect, it } from "vitest";
import type { PiSessionInfo, ThreadInfo, WireModelInfo } from "@saku/wire";
import fc from "fast-check";

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
} from "./presentation.ts";

const modelArb: fc.Arbitrary<WireModelInfo> = fc.record({
  provider: fc.string({ maxLength: 12 }),
  id: fc.string({ maxLength: 24 }),
  contextWindow: fc.integer({ min: 0 }),
  reasoning: fc.boolean(),
});

const messageArb = fc.record({
  role: fc.constantFrom("user", "assistant", "toolResult"),
  usage: fc.option(
    fc.record({
      input: fc.integer({ min: 0 }),
      cacheRead: fc.integer({ min: 0 }),
      cacheWrite: fc.integer({ min: 0 }),
      totalTokens: fc.option(fc.integer({ min: 0 })),
    }),
    { nil: undefined },
  ),
  stopReason: fc.option(fc.constantFrom("end_turn", "aborted", "error", "tool_use"), {
    nil: undefined,
  }),
});

const entryArb: fc.Arbitrary<EntryProjection> = fc.oneof(
  fc
    .record({
      seq: fc.option(fc.integer({ min: 0 }), { nil: undefined }),
      type: fc.constant("message"),
      message: fc.option(messageArb, { nil: undefined }),
    })
    .map(({ message, ...rest }) => ({ ...rest, message })),
  fc.record({
    seq: fc.option(fc.integer({ min: 0 }), { nil: undefined }),
    type: fc.constant("compaction"),
  }),
  fc.record({
    seq: fc.option(fc.integer({ min: 0 }), { nil: undefined }),
    type: fc.constant("model_change"),
  }),
);

describe("modelLabel", () => {
  it("keeps ids that already carry the provider prefix, else joins them", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 24 }), fc.string({ maxLength: 24 }), (provider, id) => {
        const model = { provider, id, contextWindow: 1, reasoning: false };
        expect(modelLabel(model)).toBe(id.includes("/") ? id : `${provider}/${id}`);
      }),
    );
  });
});

describe("usageContextTokens", () => {
  it("prefers the native totalTokens, falls back to the component sum, and nulls on junk", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0 }),
        fc.integer({ min: 0 }),
        fc.integer({ min: 0 }),
        (input, cacheRead, cacheWrite) => {
          const withTotal = {
            input,
            cacheRead,
            cacheWrite,
            totalTokens: input + cacheRead + cacheWrite + 7,
          };
          expect(usageContextTokens(withTotal)).toBe(withTotal.totalTokens);
          const componentSum = { input, cacheRead, cacheWrite };
          expect(usageContextTokens(componentSum)).toBe(input + cacheRead + cacheWrite);
        },
      ),
    );
    expect(usageContextTokens(null)).toBeNull();
    expect(usageContextTokens("nope")).toBeNull();
    expect(usageContextTokens({})).toBeNull();
    expect(usageContextTokens({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull();
  });
});

describe("contextUsage", () => {
  it("is null without a model window, without usage, or after a compaction", () => {
    fc.assert(
      fc.property(modelArb, fc.array(entryArb, { maxLength: 6 }), (model, entries) => {
        const usage = contextUsage(entries, model);
        const window = model.contextWindow;
        const lastAssistant = entries
          .filter(
            (entry) =>
              entry.type === "message" &&
              entry.message !== undefined &&
              entry.message.role === "assistant" &&
              entry.message.stopReason !== "aborted" &&
              entry.message.stopReason !== "error" &&
              usageContextTokens(entry.message.usage) !== null,
          )
          .at(-1);
        const lastCompaction = entries.filter((entry) => entry.type === "compaction").at(-1);
        const unknown =
          window <= 0 ||
          lastAssistant === undefined ||
          (lastCompaction !== undefined && (lastCompaction.seq ?? -1) > (lastAssistant.seq ?? -1));
        if (unknown) {
          expect(usage).toBeNull();
        } else {
          expect(usage).not.toBeNull();
          expect(usage!.window).toBe(window);
          expect(usage!.tokens).toBe(usageContextTokens(lastAssistant!.message!.usage));
          expect(usage!.percent).toBe(Math.round((usage!.tokens / window) * 100));
        }
      }),
    );
  });

  it("compaction entries without any assistant usage leave the badge unknown", () => {
    expect(
      contextUsage([{ type: "compaction" }], {
        provider: "p",
        id: "m",
        contextWindow: 100,
        reasoning: false,
      }),
    ).toBeNull();
    expect(
      contextUsage([], { provider: "p", id: "m", contextWindow: 100, reasoning: false }),
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

describe("filterModels", () => {
  const fixed = [
    { provider: "openai", id: "gpt-4o", contextWindow: 128000, reasoning: false },
    { provider: "anthropic", id: "claude-3-7-sonnet", contextWindow: 200000, reasoning: true },
    { provider: "opencode-go", id: "gemini/2.5-pro", contextWindow: 1000000, reasoning: true },
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
    fc.assert(
      fc.property(
        fc.array(modelArb, { maxLength: 6 }),
        fc.string({ maxLength: 12 }),
        (models, query) => {
          const kept = filterModels(models, query);
          const positions = kept.map((keptModel) => models.indexOf(keptModel));
          expect(positions).toEqual([...positions].sort((a, b) => a - b));
          expect(positions).not.toContain(-1);
        },
      ),
    );
  });
});

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

describe("unadoptedPiSessions", () => {
  it("keeps every session when no thread is adopted from pi", () => {
    fc.assert(
      fc.property(
        fc.array(threadArb, { maxLength: 4 }),
        fc.array(piSessionArb, { maxLength: 4 }),
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
    fc.assert(
      fc.property(
        fc.array(piSessionArb, { maxLength: 4 }),
        fc.string({ maxLength: 24 }),
        (sessions, threadId) => {
          const threads: ThreadInfo[] = sessions.map((session, index) => ({
            id: `${threadId}${index}`,
            name: `adopted ${index}`,
            cwd: session.cwd,
            mode: "local" as const,
            state: "idle" as const,
            env: "stopped" as const,
            sessionId: session.id,
            tailSeq: 0,
            archivedAt: null,
            source: { kind: "pi", sessionId: session.id, path: session.path },
          }));
          const kept = unadoptedPiSessions(threads, sessions);
          expect(kept).toEqual([]);
        },
      ),
    );
  });

  it("a session adopted twice stays dropped once (the filter is a set membership)", () => {
    fc.assert(
      fc.property(piSessionArb, fc.string({ maxLength: 24 }), (session, threadId) => {
        const duplicate: ThreadInfo = {
          id: threadId,
          name: "dup",
          cwd: null,
          mode: "local",
          state: "idle",
          env: "stopped",
          sessionId: null,
          tailSeq: 0,
          archivedAt: null,
          source: { kind: "pi", sessionId: session.id, path: session.path },
        };
        expect(unadoptedPiSessions([duplicate, duplicate], [session])).toEqual([]);
      }),
    );
  });
});
