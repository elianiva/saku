/**
 * The config resolution property tests (config.test.ts): the three-way
 * bootstrap resolution — a verified live daemon, the daemon-offline marker,
 * and the fallback chain (saved override → same-origin default). Exercised
 * as pure resolution with stubbed fetch/window; no DOM, no wire service.
 *
 * The properties walk the whole input space instead of hand-picked cases:
 * for any bootstrap payload and any saved config, the resolution is
 * computed by an independent oracle (written from the module's contract,
 * not from its code) and compared with the real one. The priority contract
 * falls out of the oracle: a live daemon wins over any saved config, the
 * offline marker never falls through, and the fallback chain applies only
 * when the bootstrap is absent.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Option } from "effect";
import fc from "fast-check";

import { fetchBootstrap, resolveConfig } from "./config.ts";

/** Stub `fetch` to answer `/__saku` with the given body (null = network failure). */
const stubFetch = (body: unknown) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        body === null ? { ok: false } : { ok: true, json: () => Promise.resolve(body) },
      ),
    ),
  );
};

const stubWindow = (saved: string | null) => {
  vi.stubGlobal("window", {
    location: { host: "localhost:5173", protocol: "http:" },
    localStorage: { getItem: () => saved },
  });
};

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Run a config effect in a test. The timeout guard keeps a hung resolution
 *  from hanging the runner (the .pipe carve-out the wrapper rule allows). */
const run = <A>(effect: Effect.Effect<A, never, never>) =>
  Effect.runPromise(effect.pipe(Effect.timeout("2 seconds")));

/**
 * The bootstrap oracle: a payload is a live daemon exactly when it is an
 * object with string url AND string token; it is the offline marker exactly
 * when it is an object whose url/token are each string-or-null (a
 * half-payload is offline, never a fallback trigger); anything else —
 * non-objects, wrong types — is no bootstrap at all.
 */
const bootstrapOracle = (payload: unknown) => {
  if (typeof payload !== "object" || payload === null) return Option.none();
  const { url, token } = payload as Record<string, unknown>;
  const stringOrNull = (value: unknown) => typeof value === "string" || value === null;
  if (typeof url === "string" && typeof token === "string") {
    return Option.some({ _tag: "daemon", endpoint: { url, token } });
  }
  if (stringOrNull(url) && stringOrNull(token)) return Option.some({ _tag: "offline" });
  return Option.none();
};

/** Any payload the bootstrap could publish: live, offline, half, or junk. */
const payloadArb = fc.oneof(
  fc.record({ url: fc.string(), token: fc.string() }),
  fc.record({ url: fc.constant(null), token: fc.constant(null) }),
  fc.record({ url: fc.constant(null), token: fc.string() }),
  fc.record({ url: fc.string(), token: fc.constant(null) }),
  fc.record({
    url: fc.oneof(fc.integer(), fc.boolean(), fc.constant(null), fc.string()),
    token: fc.oneof(fc.integer(), fc.boolean(), fc.constant(null), fc.string()),
  }),
  fc.jsonValue(),
);

describe("fetchBootstrap", () => {
  it("yields daemon/offline/none exactly as the payload dictates", async () => {
    await fc.assert(
      fc.asyncProperty(fc.oneof(payloadArb, fc.constant(null)), async (payload) => {
        stubFetch(payload);
        const result = await run(fetchBootstrap);
        expect(result).toEqual(bootstrapOracle(payload));
      }),
    );
  });
});

describe("resolveConfig", () => {
  it("resolves by priority: live daemon > saved override > same-origin default", async () => {
    const resolveOracle = (payload: unknown, saved: string | null) => {
      const boot = bootstrapOracle(payload);
      if (Option.isSome(boot)) return boot.value;
      if (saved !== null) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(saved);
        } catch {
          parsed = undefined;
        }
        if (typeof parsed === "object" && parsed !== null) {
          const { url, token } = parsed as Record<string, unknown>;
          if (typeof url === "string" && typeof token === "string") {
            return { _tag: "fallback", endpoint: { url, token } };
          }
        }
      }
      // The same-origin /ws default (the stub pins host and protocol).
      return { _tag: "fallback", endpoint: { url: "ws://localhost:5173/ws", token: "" } };
    };

    await fc.assert(
      fc.asyncProperty(
        fc.oneof(payloadArb, fc.constant(null)),
        fc.oneof(fc.constant(null), fc.string({ maxLength: 60 })),
        async (payload, saved) => {
          stubFetch(payload);
          stubWindow(saved);
          const result = await run(resolveConfig);
          expect(result).toEqual(resolveOracle(payload, saved));
        },
      ),
    );
  });
});
