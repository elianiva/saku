/**
 * The session-command dispatch (session-commands.ts): the single 17-case
 * map from wire `SessionCommand` to the host/catalog calls behind it,
 * shared by the local daemon (`daemon.ts`) and the thread DO
 * (`deploy/thread-do.ts`) — the two implementations used to hand-roll
 * their own switches, each with a `default: { const exhaustive: never }`
 * tail that `Match.tagsExhaustive` now replaces.
 *
 * The dispatch is parameterized by host resolution, so it is
 * isolate-clean: the daemon resolves hosts over its file-backed registry
 * and in-process `LocalEnv`; the thread DO over DO storage and
 * `RemoteEnv`. The four read-only commands are served through
 * `readOnlyHost` with no-host fallbacks (a thread that has never started
 * answers from the registry/catalog alone — browsing never starts a
 * session or wakes an env, ADR 0004); everything else takes the lazy
 * `hostFor` and starts the session on first touch.
 */

import { Effect, Match, Option } from "effect";

import {
  AbortResponse,
  BranchResponse,
  CompactResponse,
  FollowUpResponse,
  GetAvailableModelsResponse,
  GetAvailableThinkingLevelsResponse,
  GetEntriesResponse,
  GetSessionStatsResponse,
  GetStateResponse,
  PromptResponse,
  SetAutoCompactionResponse,
  SetFollowUpModeResponse,
  SetModelResponse,
  SetSessionNameResponse,
  SetSteeringModeResponse,
  SetThinkingLevelResponse,
  SteerResponse,
  THINKING_LEVELS,
} from "@saku/wire";
import type { ResponsePayload, SessionCommand, WireModelInfo } from "@saku/wire";

import type { SessionHost, SessionHostError } from "./session-host.ts";

/** The host-resolution seam the dispatch runs on (daemon and thread DO). */
export interface SessionCommandDeps<E> {
  /** Only called for mutating commands — the four reads never start a session (ADR 0004). */
  readonly hostFor: (threadId: string) => Effect.Effect<SessionHost, E>;
  /** The live host if the session already exists; None for never-started threads. */
  readonly readOnlyHost: (threadId: string) => Effect.Effect<Option.Option<SessionHost>, E>;
  /** `catalog.available()` already projected to wire info. */
  readonly availableModels: () => Effect.Effect<readonly WireModelInfo[]>;
}

/**
 * One wire session command → the host/catalog calls behind it. Host errors
 * flow as `SessionHostError` naturally; the deps' own errors (registry,
 * resolution) flow as `E` — no mapping needed here, the caller owns `E`.
 */
export const runSessionCommand = <E>(
  deps: SessionCommandDeps<E>,
  threadId: string,
  wireCommand: SessionCommand,
) =>
  Match.value(wireCommand).pipe(
    Match.withReturnType<Effect.Effect<ResponsePayload, E | SessionHostError>>(),
    Match.tagsExhaustive({
      abort: () =>
        deps.hostFor(threadId).pipe(
          Effect.flatMap((host) => host.abort()),
          Effect.as(AbortResponse.make({})),
        ),
      branch: (command) =>
        deps.hostFor(threadId).pipe(
          Effect.flatMap((host) => host.branch(command.entryId)),
          Effect.map((leafId) => BranchResponse.make({ leafId })),
        ),
      compact: (command) =>
        deps.hostFor(threadId).pipe(
          Effect.flatMap((host) => host.compact(command.customInstructions)),
          Effect.as(CompactResponse.make({})),
        ),
      follow_up: (command) =>
        deps.hostFor(threadId).pipe(
          Effect.flatMap((host) => host.followUp(command.text)),
          Effect.as(FollowUpResponse.make({})),
        ),
      get_available_models: () =>
        deps
          .availableModels()
          .pipe(Effect.map((models) => GetAvailableModelsResponse.make({ models }))),
      get_available_thinking_levels: () =>
        deps.readOnlyHost(threadId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.succeed(
                  GetAvailableThinkingLevelsResponse.make({ levels: [...THINKING_LEVELS] }),
                ),
              onSome: (host) =>
                host
                  .getAvailableThinkingLevels()
                  .pipe(
                    Effect.map((levels) => GetAvailableThinkingLevelsResponse.make({ levels })),
                  ),
            }),
          ),
        ),
      // Reads: served without a session host where possible.
      get_entries: (command) =>
        deps.readOnlyHost(threadId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.succeed(GetEntriesResponse.make({ entries: [], leafId: null, tailSeq: 0 })),
              onSome: (host) =>
                host
                  .getEntries(command.sinceSeq)
                  .pipe(
                    Effect.map(({ entries, tailSeq, leafId }) =>
                      GetEntriesResponse.make({ entries, leafId, tailSeq }),
                    ),
                  ),
            }),
          ),
        ),
      // Stats are a pure projection of the trail (message/usage counts): a
      // never-started thread's trail is empty, so its stats are zeroed — served
      // read-only like the other reads, never starting the session (ADR 0004).
      get_session_stats: () =>
        deps.readOnlyHost(threadId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.succeed(
                  GetSessionStatsResponse.make({
                    stats: {
                      cachedTokens: 0,
                      costTotal: 0,
                      messageCount: 0,
                      totalTokens: 0,
                      uncachedTokens: 0,
                    },
                  }),
                ),
              onSome: (host) =>
                host
                  .getSessionStats()
                  .pipe(Effect.map((stats) => GetSessionStatsResponse.make({ stats }))),
            }),
          ),
        ),
      get_state: () =>
        deps.readOnlyHost(threadId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.succeed(
                  GetStateResponse.make({
                    state: {
                      model: null,
                      sessionId: null,
                      state: "idle",
                      tailSeq: 0,
                      thinkingLevel: "off",
                    },
                  }),
                ),
              onSome: (host) =>
                host.getState().pipe(Effect.map((state) => GetStateResponse.make({ state }))),
            }),
          ),
        ),
      prompt: (command) =>
        deps.hostFor(threadId).pipe(
          Effect.flatMap((host) => host.prompt(command.text, command.images)),
          Effect.as(PromptResponse.make({})),
        ),
      set_auto_compaction: (command) =>
        deps.hostFor(threadId).pipe(
          Effect.flatMap((host) => host.setAutoCompaction(command.enabled)),
          Effect.as(SetAutoCompactionResponse.make({})),
        ),
      set_follow_up_mode: (command) =>
        deps.hostFor(threadId).pipe(
          Effect.flatMap((host) => host.setFollowUpMode(command.mode)),
          Effect.as(SetFollowUpModeResponse.make({})),
        ),
      set_model: (command) =>
        deps.hostFor(threadId).pipe(
          Effect.flatMap((host) => host.setModel(command.provider, command.modelId)),
          Effect.map((model) => SetModelResponse.make({ model })),
        ),
      set_session_name: (command) =>
        deps.hostFor(threadId).pipe(
          Effect.flatMap((host) => host.setSessionName(command.name)),
          Effect.as(SetSessionNameResponse.make({})),
        ),
      set_steering_mode: (command) =>
        deps.hostFor(threadId).pipe(
          Effect.flatMap((host) => host.setSteeringMode(command.mode)),
          Effect.as(SetSteeringModeResponse.make({})),
        ),
      set_thinking_level: (command) =>
        deps.hostFor(threadId).pipe(
          Effect.flatMap((host) => host.setThinkingLevel(command.level)),
          Effect.map((level) => SetThinkingLevelResponse.make({ level })),
        ),
      steer: (command) =>
        deps.hostFor(threadId).pipe(
          Effect.flatMap((host) => host.steer(command.text)),
          Effect.as(SteerResponse.make({})),
        ),
    }),
  );
