/**
 * The route parsing property tests (route.test.ts): the two-arm URL scheme —
 * the root route and `/thread/:id` — parsed through foldkit's biparser, with
 * anything unmatched falling back to the root.
 *
 * The properties pin the whole surface: any URL-safe id survives
 * `/thread/:id` byte-for-byte (the parser reads the segment raw — no
 * percent-decoding, no normalization), and the `/thread` arm is specified
 * totally: for ANY tail over the pass-through charset, the expected outcome
 * is computed from the path text alone — query/fragment are stripped first,
 * backslash is a path separator like `/` (WHATWG normalization, runs
 * collapsed), and the arm matches exactly when one non-empty id segment
 * remains. Everything else — the root's own near-misses, unknown paths —
 * falls back to Threads.
 */

import { describe, expect, it } from "vitest";
import { Option, Schema as S } from "effect";
import { Url } from "foldkit";
import fc from "fast-check";

import { parseRoute, ThreadRoute, ThreadsRoute } from "./route.ts";

/** Parse a path string into an AppRoute (the fallback never fires). */
const parse = (path: string) => {
  const url = Option.getOrThrow(Url.fromString(`http://localhost${path}`));
  const route = parseRoute(url);
  expect(S.is(ThreadsRoute)(route) || S.is(ThreadRoute)(route)).toBe(true);
  return route;
};

/**
 * The characters that round-trip through a URL path unchanged (probed:
 * everything else is percent-encoded by Url.fromString, and the parser
 * reads the segment raw). `?`/`#` are query/fragment and are stripped;
 * `/` and `\` are path separators.
 */
const ROUTE_SAFE = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.~!$&'()*+,;=:@|[]%";

/** Strings drawn from a character pool (`string({ unit })` is v4's `stringOf`). */
const stringOfChars = (chars: string, constraints?: { minLength?: number; maxLength?: number }) =>
  fc.string({ unit: fc.constantFrom(...chars.split("")), ...constraints });

/** The expected parse of `/thread${tail}` for any tail over the pass-through charset. */
const threadArm = (tail: string) => {
  // The URL parser splits query/fragment off before normalizing the path.
  const seg = tail.split(/[?#]/, 1)[0] ?? "";
  // The arm needs a separator right after `thread`; backslash counts
  // (WHATWG path normalization) — `/thread\a` is `/thread/a`.
  if (seg === "" || (seg[0] !== "/" && seg[0] !== "\\")) return { _tag: "Threads" } as const;
  const segments = seg
    .slice(1)
    .replace(/[\\/]+/g, "/")
    .split("/")
    .filter((segment) => segment !== "");
  return segments.length === 1
    ? ({ _tag: "Thread", id: segments[0] } as const)
    : ({ _tag: "Threads" } as const);
};

describe("parseRoute", () => {
  it("parses the root into the Threads route", () => {
    expect(parse("/")).toEqual({ _tag: "Threads" });
  });

  it("preserves any URL-safe id through /thread/:id", () => {
    fc.assert(
      fc.property(stringOfChars(ROUTE_SAFE, { minLength: 1, maxLength: 24 }), (id) => {
        expect(parse(`/thread/${id}`)).toEqual({ _tag: "Thread", id });
      }),
    );
  });

  it("matches the /thread arm exactly when one clean id segment remains", () => {
    fc.assert(
      fc.property(stringOfChars(`${ROUTE_SAFE}/\\?#`, { maxLength: 16 }), (tail) => {
        expect(parse(`/thread${tail}`)).toEqual(threadArm(tail));
      }),
    );
  });

  it("falls back to the Threads route for any path whose first segment is not `thread`", () => {
    fc.assert(
      fc.property(
        fc.array(stringOfChars(`${ROUTE_SAFE}/?#`, { minLength: 1, maxLength: 8 }), {
          minLength: 1,
          maxLength: 4,
        }),
        (segments) => {
          fc.pre(segments[0] !== "thread");
          expect(parse(`/${segments.join("/")}`)).toEqual({ _tag: "Threads" });
        },
      ),
    );
  });
});
