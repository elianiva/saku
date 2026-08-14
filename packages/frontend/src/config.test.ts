/**
 * The config resolution tests (config.test.ts): the three-way bootstrap
 * resolution — a verified live daemon, the daemon-offline marker, and the
 * fallback chain (saved override → same-origin default). Exercised as pure
 * resolution with stubbed fetch/window; no DOM, no wire service.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Option } from "effect";

import { fetchBootstrap, resolveConfig } from "./config.ts";

const LIVE_BOOTSTRAP = { url: "ws://127.0.0.1:57851", token: "tok" };
const OFFLINE_BOOTSTRAP = { url: null, token: null };

/** Stub `fetch` to answer `/__saku` with the given body (null = network failure). */
const stubFetch = (body: unknown): void => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        body === null ? { ok: false } : { ok: true, json: () => Promise.resolve(body) },
      ),
    ),
  );
};

const stubWindow = (saved: string | null): void => {
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
const run = <A>(effect: Effect.Effect<A, never, never>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.timeout("2 seconds")));

describe("fetchBootstrap", () => {
  it("yields a live daemon when the bootstrap publishes a url", async () => {
    stubFetch(LIVE_BOOTSTRAP);
    const result = await run(fetchBootstrap);
    expect(Option.getOrNull(result)).toEqual({ _tag: "daemon", endpoint: LIVE_BOOTSTRAP });
  });

  it("yields offline when the bootstrap marks the daemon dead", async () => {
    stubFetch(OFFLINE_BOOTSTRAP);
    const result = await run(fetchBootstrap);
    expect(Option.getOrNull(result)).toEqual({ _tag: "offline" });
  });

  it("yields nothing when the fetch fails", async () => {
    stubFetch(null);
    const result = await run(fetchBootstrap);
    expect(Option.isNone(result)).toBe(true);
  });

  it("yields nothing on a malformed bootstrap payload", async () => {
    stubFetch({ url: 42 });
    const result = await run(fetchBootstrap);
    expect(Option.isNone(result)).toBe(true);
  });

  it("treats a half-payload as offline, not as a fallback trigger", async () => {
    stubFetch({ url: "ws://127.0.0.1:57851", token: null });
    const result = await run(fetchBootstrap);
    expect(Option.getOrNull(result)).toEqual({ _tag: "offline" });
  });
});

describe("resolveConfig", () => {
  it("prefers the live daemon bootstrap", async () => {
    stubFetch(LIVE_BOOTSTRAP);
    stubWindow(null);
    const result = await run(resolveConfig);
    expect(result).toEqual({ _tag: "daemon", endpoint: LIVE_BOOTSTRAP });
  });

  it("stays offline on the offline marker instead of falling through", async () => {
    stubFetch(OFFLINE_BOOTSTRAP);
    stubWindow(null);
    const result = await run(resolveConfig);
    expect(result).toEqual({ _tag: "offline" });
  });

  it("falls back to the saved config when there is no bootstrap", async () => {
    stubFetch(null);
    stubWindow(JSON.stringify(LIVE_BOOTSTRAP));
    const result = await run(resolveConfig);
    expect(result).toEqual({ _tag: "fallback", endpoint: LIVE_BOOTSTRAP });
  });

  it("falls back to the same-origin /ws default when nothing else applies", async () => {
    stubFetch(null);
    stubWindow(null);
    const result = await run(resolveConfig);
    expect(result).toEqual({
      _tag: "fallback",
      endpoint: { url: "ws://localhost:5173/ws", token: "" },
    });
  });

  it("ignores a corrupt saved config", async () => {
    stubFetch(null);
    stubWindow("not json");
    const result = await run(resolveConfig);
    expect(result).toEqual({
      _tag: "fallback",
      endpoint: { url: "ws://localhost:5173/ws", token: "" },
    });
  });
});
