/**
 * Session host (session-host.ts): the worker's driver of one thread's pi
 * session — the server-side analogue of the shell's `AgentSession`, built
 * directly on pi-agent-core's `Agent` + `Session`, with the session's trail
 * on DO storage (`DoSessionRepo` over the `KvStore` seam, ADR 0001).
 *
 * This module is the host value: `SessionHost.create` opens/recreates the
 * DO session, recovers the durable values (model, thinking level, name)
 * from the entry trail, builds the agent, and spawns the run machine
 * (`session-machine.ts`) over the shared refs. Commands are OTP-style
 * calls into the machine (reply-bearing events, `actor.ask`); the machine
 * and the host share one failure type (`session-host-error.ts`), and pi's
 * agent events are made durable and projected onto the wire by
 * `agent-events.ts`.
 *
 * The host is an effect-machine actor:
 *
 * ```
 * Idle ──run command──▶ Working ──run finished──▶ Idle
 *   ▲                    │ run failed
 *   │                    ▼
 *   │                  Crashed (host-local; the daemon rebuilds on next touch)
 *   └─────── rebuilt ◀──┘
 *
 * Interrupted = recovered initial state (open operation in the trail)
 * Compacting  = a manual compaction in flight (auto-compaction runs inside
 *               Working)
 * ```
 */

import { Duration, Effect, Match, Option, Ref } from "effect";
import { Machine } from "effect-machine";
import {
  Agent,
  buildSessionContext,
  convertToLlm,
  DEFAULT_COMPACTION_SETTINGS,
  type AgentEvent,
  type CompactionSettings,
  type Entry,
  type ExecutionEnv,
  type SessionStats,
  type StreamFn,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { THINKING_LEVELS, type ThreadState, type WireModelInfo } from "@saku/wire";

import { DoSessionRepo } from "./do-session.ts";
import { KvStore } from "@saku/store";
import type { ModelCatalogShape } from "./model-catalog.ts";
import { buildTools } from "./tools.ts";
import { RegistryError } from "./registry-error.ts";
import type { ThreadRecord, ThreadRegistryShape } from "./registry.ts";
import { SessionHostError, toSessionHostError } from "./session-host-error.ts";
import { handleAgentEvent } from "./agent-events.ts";
import {
  entriesFromLog,
  hostStateOf,
  wireStateOf,
  LANE,
  HostEvent,
  HostState,
  makeHostMachine,
  type HostCommandEvent,
  type HostDeps,
  type HostEventSink,
  type HostStateV,
  type ReplyOk,
  type SessionHostState,
} from "./session-machine.ts";

export { SessionHostError } from "./session-host-error.ts";
export type { HostEventSink, SessionHostState as HostState } from "./session-machine.ts";

// ---------------------------------------------------------------------------
// The host value
// ---------------------------------------------------------------------------

export interface SessionHost {
  readonly threadId: string;
  /** The host-local lifecycle tag; the daemon rebuilds a crashed host. */
  readonly threadState: SessionHostState;
  readonly getState: () => Effect.Effect<
    {
      sessionId: string | null;
      name?: string;
      state: ThreadState;
      tailSeq: number;
      model: WireModelInfo | null;
      thinkingLevel: ThinkingLevel;
    },
    SessionHostError,
    never
  >;
  readonly getEntries: (
    sinceSeq?: number,
  ) => Effect.Effect<
    { entries: Entry[]; tailSeq: number; leafId: string | null },
    SessionHostError,
    never
  >;
  readonly getSessionStats: () => Effect.Effect<SessionStats, SessionHostError, never>;
  readonly getAvailableThinkingLevels: () => Effect.Effect<ThinkingLevel[], never>;
  readonly prompt: (
    text: string,
    images?: ReadonlyArray<unknown>,
  ) => Effect.Effect<void, SessionHostError, never>;
  readonly steer: (text: string) => Effect.Effect<void, SessionHostError, never>;
  readonly followUp: (text: string) => Effect.Effect<void, SessionHostError, never>;
  readonly abort: () => Effect.Effect<void, SessionHostError, never>;
  readonly compact: (
    customInstructions?: string,
  ) => Effect.Effect<unknown, SessionHostError, never>;
  readonly setAutoCompaction: (enabled: boolean) => Effect.Effect<void, SessionHostError, never>;
  readonly setModel: (
    provider: string,
    modelId: string,
  ) => Effect.Effect<WireModelInfo | null, SessionHostError, never>;
  readonly setThinkingLevel: (
    level: ThinkingLevel,
  ) => Effect.Effect<ThinkingLevel, SessionHostError, never>;
  readonly setSessionName: (name: string) => Effect.Effect<void, SessionHostError, never>;
  /** Move the lane leaf to a past entry (fork-on-next-prompt). Idle threads only. */
  readonly branch: (entryId: string) => Effect.Effect<string | null, SessionHostError, never>;
  readonly setSteeringMode: (mode: "all" | "one-at-a-time") => Effect.Effect<void, never>;
  readonly setFollowUpMode: (mode: "all" | "one-at-a-time") => Effect.Effect<void, never>;
  /** Best-effort teardown: settle the run, drain the actor, release the env. */
  readonly dispose: () => Effect.Effect<void, never>;
}

export interface SessionHostOptions {
  readonly threadId: string;
  /** The registry record; its sessionId is back-filled when null (first touch). */
  readonly record: ThreadRecord;
  readonly catalog: ModelCatalogShape;
  readonly registry: ThreadRegistryShape;
  readonly sink: HostEventSink;
  readonly onRecordChanged?: (record: ThreadRecord) => void;
  /** Test seam: the agent's stream function. Defaults to the catalog's models. */
  readonly streamFn?: StreamFn;
  /** The thread's hands (an env daemon client, local or remote). */
  readonly env: ExecutionEnv;
}

/** Create the host for a thread: open/create the DO session, recover, spawn. */
export const SessionHost = {
  create(
    options: SessionHostOptions,
  ): Effect.Effect<SessionHost, SessionHostError | RegistryError, KvStore> {
    return Effect.gen(function* () {
      const { threadId, record, catalog, registry, env } = options;
      // The trail: the session's mutations on the `KvStore` service (the
      // daemon provides a file-backed layer; a Durable Object provides its
      // own storage through the same seam).
      const kv = yield* KvStore;
      const repo = new DoSessionRepo(kv);
      const found = (yield* Effect.tryPromise({
        try: () => repo.list(),
        catch: toSessionHostError,
      })).find((metadata) => metadata.id === threadId);
      const session =
        found === undefined
          ? yield* Effect.tryPromise({
              try: () => repo.create({ id: threadId }),
              catch: toSessionHostError,
            })
          : yield* Effect.tryPromise({ try: () => repo.open(found), catch: toSessionHostError });
      if (record.sessionId === null) {
        // First touch (or a crash between repo creation and the registry update
        // on a previous boot): back-fill the stable session id.
        yield* registry
          .update(threadId, { sessionId: threadId })
          .pipe(Effect.mapError(toSessionHostError));
      }

      const entries = entriesFromLog(
        yield* Effect.tryPromise({ try: () => session.getLog(), catch: toSessionHostError }),
      );
      const context = buildSessionContext(entries);

      // Recover model + thinking level from the entry trail. A fresh thread
      // defaults to the first available model (pi's own habit: a new session
      // starts with the default from auth.json), persisted as a model_change
      // entry below.
      let model: Model<Api> | null = null;
      let thinkingLevel: ThinkingLevel = "off";
      for (const entry of entries) {
        if (entry.type === "model_change") {
          model = catalog.getModel(entry.provider, entry.modelId) ?? null;
        } else if (entry.type === "thinking_level_change") {
          thinkingLevel = entry.thinkingLevel as ThinkingLevel;
        }
      }
      if (model === null) {
        const available = yield* Effect.tryPromise({
          try: () => catalog.models.getAvailable(),
          catch: toSessionHostError,
        });
        model = available[0] ?? null;
      }

      // Recovery: an unfinished operation means the daemon died mid-run.
      const openOperations = yield* Effect.tryPromise({
        try: () => session.findOpenOperations(LANE, { limit: 1 }),
        catch: toSessionHostError,
      });
      const initialState: HostStateV =
        openOperations.length > 0 ? HostState.Interrupted : HostState.Idle;

      const agent = new Agent({
        initialState: {
          systemPrompt: "",
          ...(model === null ? {} : { model }),
          thinkingLevel,
          tools: buildTools(env),
        },
        convertToLlm,
        streamFn:
          options.streamFn ??
          ((modelForRequest, streamContext, streamOptions) =>
            catalog.models.streamSimple(modelForRequest, streamContext, streamOptions)),
        sessionId: threadId,
        steeringMode: "all",
        followUpMode: "all",
      });

      // Restore the live transcript; new sessions get their initial trail.
      if (entries.length > 0) {
        agent.state.messages = context.messages;
      } else {
        if (model !== null) {
          yield* Effect.tryPromise({
            try: () =>
              session.appendEntry(
                {
                  id: session.idGenerator.next(),
                  type: "model_change",
                  provider: model.provider,
                  modelId: model.id,
                },
                LANE,
              ),
            catch: toSessionHostError,
          });
        }
        yield* Effect.tryPromise({
          try: () =>
            session.appendEntry(
              { id: session.idGenerator.next(), type: "thinking_level_change", thinkingLevel },
              LANE,
            ),
          catch: toSessionHostError,
        });
      }

      // Refs shared by the machine and the value (volatile config; the durable
      // values live in the trail).
      const modelRef = yield* Ref.make<Model<Api> | null>(model);
      const thinkingLevelRef = yield* Ref.make<ThinkingLevel>(thinkingLevel);
      const compactionSettingsRef = yield* Ref.make<CompactionSettings>({
        ...DEFAULT_COMPACTION_SETTINGS,
      });
      const lastAssistantRef = yield* Ref.make<AssistantMessage | undefined>(undefined);
      const compactionAbortRef = yield* Ref.make<Option.Option<AbortController>>(Option.none());

      const deps: HostDeps = {
        threadId,
        agent,
        session,
        catalog,
        registry,
        sink: options.sink,
        onRecordChanged: options.onRecordChanged,
        modelRef,
        thinkingLevelRef,
        compactionSettingsRef,
        lastAssistantRef,
        compactionAbortRef,
        initialState,
        pushState: (state) => registry.setState(threadId, state),
      };

      const unsubscribeAgent = agent.subscribe(
        (event: AgentEvent, _signal: AbortSignal): Promise<void> =>
          Effect.runPromise(handleAgentEvent(deps, event)),
      );

      const actor = yield* Machine.spawn(makeHostMachine(deps));
      yield* actor.start;

      const command = (event: HostCommandEvent): Effect.Effect<ReplyOk, SessionHostError, never> =>
        actor.ask(event).pipe(
          Effect.flatMap((reply) =>
            Match.value(reply).pipe(
              Match.tagsExhaustive({
                reply_ok: (ok) => Effect.succeed(ok),
                reply_failed: (failed) =>
                  Effect.fail(
                    new SessionHostError({ kind: "command_failed", message: failed.message }),
                  ),
              }),
            ),
          ),
          Effect.mapError(toSessionHostError),
        );

      const getEntries = (
        sinceSeq?: number,
      ): Effect.Effect<
        { entries: Entry[]; tailSeq: number; leafId: string | null },
        SessionHostError,
        never
      > =>
        Effect.gen(function* () {
          const log = yield* Effect.tryPromise({
            try: () =>
              session.getLog({ ...(sinceSeq === undefined ? {} : { afterSeq: sinceSeq }) }),
            catch: toSessionHostError,
          });
          const entries = entriesFromLog(log);
          const last = log[log.length - 1];
          const tailSeq = last === undefined ? (sinceSeq ?? 0) : last.seq;
          const leafId = yield* Effect.tryPromise({
            try: () => session.getLeafId(),
            catch: toSessionHostError,
          });
          return { entries, tailSeq, leafId };
        });

      const dispose = (): Effect.Effect<void, never> =>
        Effect.gen(function* () {
          unsubscribeAgent();
          // Settle an in-flight run; the run's own effect then finishes it.
          const compactionAbort = yield* Ref.get(compactionAbortRef);
          if (Option.isSome(compactionAbort)) compactionAbort.value.abort();
          agent.abort();
          yield* actor
            .waitFor((state) => state._tag !== "Working" && state._tag !== "Compacting")
            .pipe(Effect.timeout(Duration.seconds(10)), Effect.ignore);
          yield* actor.drain;
          // Best-effort teardown: a cleanup failure is a typed pi-seam
          // failure, swallowed by the dispose's `Effect.ignore` below.
          yield* Effect.tryPromise({ try: () => env.cleanup(), catch: toSessionHostError });
        }).pipe(Effect.ignore);

      return {
        threadId,
        get threadState() {
          return hostStateOf(actor.sync.snapshot());
        },
        getState: () =>
          Effect.gen(function* () {
            const [name, { tailSeq }, snapshot, modelValue, thinkingLevelValue] = yield* Effect.all(
              [
                Effect.tryPromise({ try: () => session.getName(), catch: toSessionHostError }),
                getEntries(),
                actor.snapshot,
                Ref.get(modelRef),
                Ref.get(thinkingLevelRef),
              ],
            );
            return {
              sessionId: agent.sessionId ?? null,
              ...(name === undefined ? {} : { name }),
              state: wireStateOf(snapshot),
              tailSeq,
              model: modelValue === null ? null : catalog.toWireInfo(modelValue),
              thinkingLevel: thinkingLevelValue,
            };
          }),
        getEntries,
        getSessionStats: () =>
          Effect.tryPromise({ try: () => session.getStats(), catch: toSessionHostError }),
        getAvailableThinkingLevels: () =>
          Ref.get(modelRef).pipe(
            Effect.map((modelValue) =>
              modelValue === null
                ? [...THINKING_LEVELS]
                : (getSupportedThinkingLevels(modelValue) as ThinkingLevel[]),
            ),
          ),
        prompt: (text, images) =>
          command(HostEvent.PromptRequested({ text, images })).pipe(Effect.asVoid),
        steer: (text) => command(HostEvent.SteerRequested({ text })).pipe(Effect.asVoid),
        followUp: (text) => command(HostEvent.FollowUpRequested({ text })).pipe(Effect.asVoid),
        abort: () => command(HostEvent.AbortRequested).pipe(Effect.asVoid),
        compact: (customInstructions) =>
          command(HostEvent.CompactRequested({ customInstructions })).pipe(
            Effect.map((reply) => reply.result),
          ),
        setAutoCompaction: (enabled) =>
          command(HostEvent.SetAutoCompactionRequested({ enabled })).pipe(Effect.asVoid),
        setModel: (provider, modelId) =>
          command(HostEvent.SetModelRequested({ provider, modelId })).pipe(
            Effect.map((reply) => reply.model ?? null),
          ),
        setThinkingLevel: (level) =>
          command(HostEvent.SetThinkingLevelRequested({ level })).pipe(
            Effect.map((reply) => reply.level ?? level),
          ),
        setSessionName: (name) =>
          command(HostEvent.SetSessionNameRequested({ name })).pipe(Effect.asVoid),
        branch: (entryId) =>
          Effect.gen(function* () {
            const snapshot = yield* actor.snapshot;
            if (snapshot._tag === "Working" || snapshot._tag === "Compacting") {
              return yield* Effect.fail(
                new SessionHostError({
                  kind: "branch_busy",
                  message: "cannot branch while the agent is working",
                }),
              );
            }
            const entry = yield* Effect.tryPromise({
              try: () => session.getEntry(entryId),
              catch: toSessionHostError,
            });
            if (entry === undefined) {
              return yield* Effect.fail(
                new SessionHostError({
                  kind: "unknown_entry",
                  message: `unknown entry: ${entryId}`,
                }),
              );
            }
            yield* Effect.tryPromise({
              try: () => session.moveLane(LANE, entryId),
              catch: toSessionHostError,
            });
            return entryId;
          }),
        setSteeringMode: (mode) =>
          Effect.sync(() => {
            agent.steeringMode = mode;
          }),
        setFollowUpMode: (mode) =>
          Effect.sync(() => {
            agent.followUpMode = mode;
          }),
        dispose,
      };
    });
  },
};
