/**
 * The route parsing tests (route.test.ts): the two-arm URL scheme — the
 * root route and `/thread/:id` — parsed through foldkit's biparser, with
 * anything unmatched falling back to the root.
 */

import { describe, expect, it } from "vitest";
import { Option, Schema as S } from "effect";
import { Url } from "foldkit";

import { parseRoute, ThreadRoute, ThreadsRoute } from "./route.ts";

/** Parse a path string into an AppRoute (the fallback never fires). */
const parse = (path: string) => {
  const url = Option.getOrThrow(Url.fromString(`http://localhost${path}`));
  const route = parseRoute(url);
  expect(S.is(ThreadsRoute)(route) || S.is(ThreadRoute)(route)).toBe(true);
  return route;
};

describe("parseRoute", () => {
  it("parses the root into the Threads route", () => {
    expect(parse("/")).toEqual({ _tag: "Threads" });
  });

  it("parses /thread/:id into the Thread route with the id", () => {
    expect(parse("/thread/abc123")).toEqual({ _tag: "Thread", id: "abc123" });
  });

  it("parses ids with URL-safe characters", () => {
    expect(parse("/thread/thread_42")).toEqual({ _tag: "Thread", id: "thread_42" });
  });

  it("falls back to the Threads route for unknown paths", () => {
    const url = Option.getOrThrow(Url.fromString("http://localhost/somewhere/else"));
    expect(parseRoute(url)).toEqual({ _tag: "Threads" });
  });
});
