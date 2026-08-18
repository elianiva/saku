/**
 * Session-command dispatch tests (session-commands.test.ts): the ADR 0004
 * read-only posture — the read commands never start a session. The
 * `get_session_stats` regression: stats are a pure projection of the trail
 * (message/usage counts), so a never-started thread answers zeroed stats
 * and `hostFor` is never touched (a console fetching stats must not
 * silently create the thread's session).
 */

import { describe, expect, it, vi } from "vitest";
import { Effect, Option } from "effect";

import { GetSessionStatsCommand, GetSessionStatsResponse } from "@saku/wire";

import type { SessionHost } from "../src/session-host.ts";
import { runSessionCommand } from "../src/session-commands.ts";

const ZEROED_STATS = {
  cachedTokens: 0,
  costTotal: 0,
  messageCount: 0,
  totalTokens: 0,
  uncachedTokens: 0,
};

describe("runSessionCommand: get_session_stats read-only posture", () => {
  it("answers zeroed stats for a never-started thread without starting the session", async () => {
    const hostFor = vi.fn(() =>
      Effect.die(new Error("get_session_stats must never start a session (ADR 0004)")),
    );
    const response = await Effect.runPromise(
      runSessionCommand(
        {
          availableModels: () => Effect.succeed([]),
          hostFor,
          readOnlyHost: () => Effect.succeed(Option.none()),
        },
        "thread-1",
        GetSessionStatsCommand.make({}),
      ),
    );

    expect(hostFor).not.toHaveBeenCalled();
    expect(response).toEqual(GetSessionStatsResponse.make({ stats: ZEROED_STATS }));
  });

  it("serves the live host's stats once the session has started", async () => {
    const liveStats = {
      cachedTokens: 12,
      costTotal: 0.001,
      messageCount: 3,
      totalTokens: 150,
      uncachedTokens: 138,
    };
    // The read-only branch only touches getSessionStats; a structural fake
    // covers the passthrough without building a full host.
    const host = {
      getSessionStats: () => Effect.succeed(liveStats),
    } as unknown as SessionHost;
    const response = await Effect.runPromise(
      runSessionCommand(
        {
          availableModels: () => Effect.succeed([]),
          hostFor: () => Effect.die(new Error("hostFor must not be called")),
          readOnlyHost: () => Effect.succeed(Option.some(host)),
        },
        "thread-1",
        GetSessionStatsCommand.make({}),
      ),
    );

    expect(response).toEqual(GetSessionStatsResponse.make({ stats: liveStats }));
  });
});
