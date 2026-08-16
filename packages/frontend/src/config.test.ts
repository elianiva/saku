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
import { Effect, Option, Schema as S } from "effect";
import type { JsonValue } from "fast-check";
import {
  assert,
  asyncProperty,
  boolean,
  constant,
  integer,
  jsonValue,
  oneof,
  record,
  string,
} from "fast-check";
import { fetchBootstrap, resolveConfig } from "./config.ts";

/** Stub `fetch` to answer `/__saku` with the given body (null = network failure). */
const stubFetch = (body: JsonValue) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if (body === null) {
        return { ok: false };
      }
      const response = { json: async () => await Promise.resolve(body), ok: true };
      return await Promise.resolve(response);
    }),
  );
};

const stubWindow = (saved: string | null) => {
  vi.stubGlobal("window", {
    localStorage: { getItem: () => saved },
    location: { host: "localhost:5173", protocol: "http:" },
  });
};

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The bootstrap payload decode, re-derived from the module contract. */
const BootstrapSchema = S.Struct({ token: S.NullOr(S.String), url: S.NullOr(S.String) });

/**
 * The bootstrap oracle: a payload is a live daemon exactly when it is an
 * object with string url AND string token; it is the offline marker exactly
 * when its url/token are each string-or-null (a half-payload is offline,
 * never a fallback trigger); anything else — non-objects, wrong types — is
 * no bootstrap at all.
 */
const bootstrapOracle = (payload: JsonValue) => {
  const decoded = S.decodeUnknownOption(BootstrapSchema)(payload);
  if (Option.isNone(decoded)) {
    return Option.none();
  }
  const { token, url } = decoded.value;
  if (url !== null && token !== null) {
    return Option.some({ _tag: "daemon", endpoint: { token, url } });
  }
  return Option.some({ _tag: "offline" });
};

/** Any payload the bootstrap could publish: live, offline, half, or junk. */
const payloadArb = oneof(
  record({ token: string(), url: string() }),
  record({ token: constant(null), url: constant(null) }),
  record({ token: string(), url: constant(null) }),
  record({ token: constant(null), url: string() }),
  record({
    token: oneof(integer(), boolean(), constant(null), string()),
    url: oneof(integer(), boolean(), constant(null), string()),
  }),
  jsonValue(),
);

describe("fetchBootstrap", () => {
  it("yields daemon/offline/none exactly as the payload dictates", async () => {
    await assert(
      asyncProperty(oneof(payloadArb, constant(null)), async (payload) => {
        stubFetch(payload);
        const result = await Effect.runPromise(fetchBootstrap.pipe(Effect.timeout("2 seconds")));
        expect(result).toEqual(bootstrapOracle(payload));
      }),
    );
  });
});

describe("resolveConfig", () => {
  it("resolves by priority: live daemon > saved override > same-origin default", async () => {
    const resolveOracle = (payload: JsonValue, saved: string | null) => {
      const boot = bootstrapOracle(payload);
      if (Option.isSome(boot)) {
        return boot.value;
      }
      if (saved !== null) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(saved);
        } catch {
          parsed = undefined;
        }
        const decoded = S.decodeUnknownOption(BootstrapSchema)(parsed);
        if (Option.isSome(decoded) && decoded.value.url !== null && decoded.value.token !== null) {
          return {
            _tag: "fallback",
            endpoint: { token: decoded.value.token, url: decoded.value.url },
          };
        }
      }
      // The same-origin /ws default (the stub pins host and protocol).
      return { _tag: "fallback", endpoint: { token: "", url: "ws://localhost:5173/ws" } };
    };

    await assert(
      asyncProperty(
        oneof(payloadArb, constant(null)),
        oneof(constant(null), string({ maxLength: 60 })),
        async (payload, saved) => {
          stubFetch(payload);
          stubWindow(saved);
          const result = await Effect.runPromise(resolveConfig.pipe(Effect.timeout("2 seconds")));
          expect(result).toEqual(resolveOracle(payload, saved));
        },
      ),
    );
  });
});
