/**
 * Thread presentation tests (presentation.test.ts): the composer status
 * bar's pure derivations — the model badge label, the context-token decode
 * (pi's usage payloads), the trail's context usage, and the 60/90 tone
 * rule. Exercised as properties, the house style.
 */

import { describe, expect, it } from "vitest";
import type { WireModelInfo } from "@saku/wire";
import fc from "fast-check";

import type { EntryProjection } from "./thread/projection.ts";
import {
  CONTEXT_CRITICAL_PERCENT,
  CONTEXT_WARNING_PERCENT,
  contextTone,
  contextUsage,
  modelLabel,
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
          const withTotal = { input, cacheRead, cacheWrite, totalTokens: input + cacheRead + cacheWrite + 7 };
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
        const lastCompaction = entries
          .filter((entry) => entry.type === "compaction")
          .at(-1);
        const unknown =
          window <= 0 ||
          lastAssistant === undefined ||
          (lastCompaction !== undefined &&
            (lastCompaction.seq ?? -1) > (lastAssistant.seq ?? -1));
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
    expect(contextUsage([{ type: "compaction" }], { provider: "p", id: "m", contextWindow: 100, reasoning: false })).toBeNull();
    expect(contextUsage([], { provider: "p", id: "m", contextWindow: 100, reasoning: false })).toBeNull();
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
