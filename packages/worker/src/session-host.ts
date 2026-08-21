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
 * calls into the machine (reply-bearing events, `actor.ask`); run commands
 * (prompt/steer/follow-up) and compaction ack at acceptance — their outcome
 * rides the session events — while config commands answer with their
 * resolved value. The machine and the host share one failure type
 * (`session-host-error.ts`), and pi's agent events are made durable and
 * projected onto the wire by `agent-events.ts`.
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
} from "@earendil-works/pi-agent-core";
import type {
  AgentEvent,
  AgentState,
  CompactionSettings,
  Entry,
  ExecutionEnv,
  SessionStats,
  StreamFn,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { THINKING_LEVELS } from "@saku/wire";
import type { ThreadState, WireModelInfo } from "@saku/wire";

import { DoSessionRepo } from "./do-session-repo.ts";
import { KvStore } from "@saku/store";
import type { ModelCatalogApi } from "./model-catalog.ts";
import { buildTools } from "./tools.ts";
import type { HostRegistryApi, ThreadRecord } from "./registry.ts";
import { SessionHostError, toSessionHostError } from "./session-host-error.ts";
import { handleAgentEvent } from "./agent-events.ts";
import { makeTrailSession } from "./trail-session.ts";
import {
  entriesOf,
  hostStateOf,
  wireStateOf,
  LANE,
  HostEvent,
  HostMachine,
  HostState,
} from "./session-machine.ts";
import type {
  HostCommandEvent,
  HostDeps,
  HostEventSink,
  HostStateV,
  SessionHostState,
} from "./session-machine.ts";

export { SessionHostError } from "./session-host-error.ts";
export type { HostEventSink, SessionHostState as HostState } from "./session-machine.ts";

/** How long `dispose` waits for a stuck host (a run that never settles) before giving up and draining the actor anyway. */
const DISPOSE_SETTLE_TIMEOUT = Duration.seconds(10);

/** Narrow a trail `thinking_level_change` value to a supported level (trail values predate wire validation). */
// A Set from the canonical ladder: `has` takes any string, so the
// `readonly string[]` cast the array's `includes` needed disappears.
const THINKING_LEVELS_SET = new Set<string>(THINKING_LEVELS);
const isThinkingLevel = (level: string): level is ThinkingLevel => THINKING_LEVELS_SET.has(level);

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
    SessionHostError
  >;
  readonly getEntries: (
    sinceSeq?: number,
  ) => Effect.Effect<
    { entries: Entry[]; tailSeq: number; leafId: string | null },
    SessionHostError
  >;
  readonly getSessionStats: () => Effect.Effect<SessionStats, SessionHostError>;
  readonly getAvailableThinkingLevels: () => Effect.Effect<ThinkingLevel[]>;
  readonly prompt: (
    text: string,
    images?: readonly unknown[],
  ) => Effect.Effect<void, SessionHostError>;
  readonly steer: (text: string) => Effect.Effect<void, SessionHostError>;
  readonly followUp: (text: string) => Effect.Effect<void, SessionHostError>;
  readonly abort: () => Effect.Effect<void, SessionHostError>;
  /** Acked at acceptance; progress and the result ride `compaction_start`/`compaction_end`. */
  readonly compact: (customInstructions?: string) => Effect.Effect<void, SessionHostError>;
  readonly setAutoCompaction: (enabled: boolean) => Effect.Effect<void, SessionHostError>;
  readonly setModel: (
    provider: string,
    modelId: string,
  ) => Effect.Effect<WireModelInfo | null, SessionHostError>;
  readonly setThinkingLevel: (
    level: ThinkingLevel,
  ) => Effect.Effect<ThinkingLevel, SessionHostError>;
  readonly setSessionName: (name: string) => Effect.Effect<void, SessionHostError>;
  /** Move the lane leaf to a past entry (fork-on-next-prompt). Idle threads only. */
  readonly branch: (entryId: string) => Effect.Effect<string | null, SessionHostError>;
  readonly setSteeringMode: (mode: "all" | "one-at-a-time") => Effect.Effect<void>;
  readonly setFollowUpMode: (mode: "all" | "one-at-a-time") => Effect.Effect<void>;
  /** Best-effort teardown: settle the run, drain the actor, release the env. */
  readonly dispose: () => Effect.Effect<void>;
}

/** The durable state projection the host serves (the wire `get_state` payload body). */
interface HostStateProjection {
  sessionId: string | null;
  name?: string;
  state: ThreadState;
  tailSeq: number;
  model: WireModelInfo | null;
  thinkingLevel: ThinkingLevel;
}

export interface SessionHostOptions {
  readonly threadId: string;
  /** The registry record; its sessionId is back-filled when null (first touch). */
  readonly record: ThreadRecord;
  readonly catalog: ModelCatalogApi;
  /** The host's registry view (get/update/setState — the narrow seam). */
  readonly registry: HostRegistryApi;
  readonly sink: HostEventSink;
  readonly onRecordChanged?: (record: ThreadRecord) => void;
  /** Test seam: the agent's stream function. Defaults to the catalog's models. */
  readonly streamFn?: StreamFn;
  /** The thread's hands (an env daemon client, local or remote). */
  readonly env: ExecutionEnv;
}

/** Create the host for a thread: open/create the DO session, recover, spawn. */
export const SessionHost = {
  create(options: SessionHostOptions) {
    return Effect.fn("SessionHost.create")(function* () {
      const { threadId, record, catalog, registry, env } = options;
      // The trail: the session's mutations on the `KvStore` service (the
      // daemon provides a file-backed layer; a Durable Object provides its
      // own storage through the same seam).
      const kv = yield* KvStore;
      const repo = new DoSessionRepo(kv);
      const found = (yield* Effect.tryPromise({
        catch: toSessionHostError,
        try: async () => await repo.list(),
      })).find((metadata) => metadata.id === threadId);
      const session =
        found === undefined
          ? yield* Effect.tryPromise({
              catch: toSessionHostError,
              try: async () => await repo.create({ id: threadId }),
            })
          : yield* Effect.tryPromise({
              catch: toSessionHostError,
              try: async () => await repo.open(found),
            });
      if (record.sessionId === null) {
        // First touch (or a crash between repo creation and the registry update
        // on a previous boot): back-fill the stable session id.
        yield* registry.update(threadId, { sessionId: threadId });
      }

      // The Effect adapter: every async Session method crosses the pi promise
      // boundary here, once, instead of at ~35 call sites (the machine, the
      // host value, the agent-event projection all use `trail`).
      const trail = makeTrailSession(session);

      const entries = entriesOf(yield* trail.getLog());
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
          const { thinkingLevel: trailThinkingLevel } = entry;
          if (isThinkingLevel(trailThinkingLevel)) {
            thinkingLevel = trailThinkingLevel;
          }
        }
      }
      if (model === null) {
        const available = yield* Effect.tryPromise({
          catch: toSessionHostError,
          try: async () => await catalog.models.getAvailable(),
        });
        model = available[0] ?? null;
      }

      // Recovery: an unfinished operation means the daemon died mid-run.
      const openOperations = yield* trail.findOpenOperations(LANE, { limit: 1 });
      const initialState: HostStateV =
        openOperations.length > 0 ? HostState.Interrupted : HostState.Idle;

      const initialAgentState: Partial<
        Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">
      > = {
        systemPrompt: "",
        thinkingLevel,
        tools: buildTools(env),
      };
      if (model !== null) {
        initialAgentState.model = model;
      }

      const agent = new Agent({
        convertToLlm,
        followUpMode: "all",
        initialState: initialAgentState,
        sessionId: threadId,
        steeringMode: "all",
        streamFn:
          options.streamFn ??
          ((modelForRequest, streamContext, streamOptions) =>
            catalog.models.streamSimple(modelForRequest, streamContext, streamOptions)),
      });

      // Restore the live transcript; new sessions get their initial trail.
      if (entries.length > 0) {
        agent.state.messages = context.messages;
      } else {
        if (model !== null) {
          yield* trail.appendEntry(
            {
              id: trail.idGenerator.next(),
              modelId: model.id,
              provider: model.provider,
              type: "model_change",
            },
            LANE,
          );
        }
        yield* trail.appendEntry(
          { id: trail.idGenerator.next(), thinkingLevel, type: "thinking_level_change" },
          LANE,
        );
      }

      // Refs shared by the machine and the value (volatile config; the durable
      // values live in the trail).
      const modelRef = yield* Ref.make<Model<Api> | null>(model);
      const thinkingLevelRef = yield* Ref.make<ThinkingLevel>(thinkingLevel);
      const compactionSettingsRef = yield* Ref.make<CompactionSettings>({
        ...DEFAULT_COMPACTION_SETTINGS,
      });
      const lastAssistantRef = yield* Ref.make<AssistantMessage | undefined>(
        undefined satisfies undefined,
      );
      const compactionAbortRef = yield* Ref.make<Option.Option<AbortController>>(Option.none());

      const deps: HostDeps = {
        agent,
        catalog,
        compactionAbortRef,
        compactionSettingsRef,
        initialState,
        lastAssistantRef,
        modelRef,
        onRecordChanged: options.onRecordChanged,
        pushState: (state) => registry.setState(threadId, state),
        registry,
        trail,
        sink: options.sink,
        thinkingLevelRef,
        threadId,
      };

      // The trail append is the durability point: a failure here must be
      // visible, never an unhandled rejection in pi's subscriber — log the
      // full cause and keep the session alive (one dropped event must not
      // kill the agent).
      const unsubscribeAgent = agent.subscribe(async (event: AgentEvent, _signal: AbortSignal) => {
        await Effect.runPromise(
          handleAgentEvent(deps, event).pipe(Effect.catchCause(Effect.logError)),
        );
      });

      const actor = yield* Machine.spawn(HostMachine.make(deps));
      yield* actor.start;

      const command = (event: HostCommandEvent) =>
        actor.ask(event).pipe(
          Effect.flatMap((reply) =>
            Match.value(reply).pipe(
              Match.tagsExhaustive({
                reply_failed: (failed) =>
                  Effect.fail(
                    new SessionHostError({ kind: "command_failed", message: failed.message }),
                  ),
                reply_ok: (ok) => Effect.succeed(ok),
              }),
            ),
          ),
          Effect.mapError(toSessionHostError),
        );

      const getEntries = Effect.fn("getEntries")(function* (sinceSeq?: number) {
        const log = yield* trail.getLog(sinceSeq === undefined ? {} : { afterSeq: sinceSeq });
        const logEntries = entriesOf(log);
        const last = log.at(-1);
        const tailSeq = last === undefined ? (sinceSeq ?? 0) : last.seq;
        const leafId = yield* trail.getLeafId();
        return { entries: logEntries, leafId, tailSeq };
      });

      const dispose = Effect.fn("dispose")(function* () {
        unsubscribeAgent();
        // Settle an in-flight run; the run's own effect then finishes it.
        const compactionAbort = yield* Ref.get(compactionAbortRef);
        if (Option.isSome(compactionAbort)) {
          compactionAbort.value.abort();
        }
        agent.abort();
        // A stuck host (a run that never settles) costs this long on daemon
        // close before the dispose gives up and drains the actor anyway.
        yield* actor
          .waitFor((state) => state._tag !== "Working" && state._tag !== "Compacting")
          .pipe(Effect.timeout(DISPOSE_SETTLE_TIMEOUT), Effect.ignore);
        yield* actor.drain;
        // Best-effort teardown: a cleanup failure is a typed pi-seam
        // failure, swallowed by the dispose's `Effect.ignore` below.
        yield* Effect.tryPromise({
          catch: toSessionHostError,
          try: async () => {
            await env.cleanup();
          },
        }).pipe(Effect.ignore);
      });

      return {
        abort: () => command(HostEvent.AbortRequested).pipe(Effect.asVoid),
        branch: Effect.fn("branch")(function* (entryId) {
          const snapshot = yield* actor.snapshot;
          if (snapshot._tag === "Working" || snapshot._tag === "Compacting") {
            return yield* Effect.fail(
              new SessionHostError({
                kind: "branch_busy",
                message: "cannot branch while the agent is working",
              }),
            );
          }
          const entry = yield* trail.getEntry(entryId);
          if (entry === undefined) {
            return yield* Effect.fail(
              new SessionHostError({
                kind: "unknown_entry",
                message: `unknown entry: ${entryId}`,
              }),
            );
          }
          yield* trail.moveLane(LANE, entryId);
          return entryId;
        }),
        compact: (customInstructions) =>
          command(HostEvent.CompactRequested({ customInstructions })).pipe(Effect.asVoid),
        dispose,
        followUp: (text) => command(HostEvent.FollowUpRequested({ text })).pipe(Effect.asVoid),
        getAvailableThinkingLevels: () =>
          Ref.get(modelRef).pipe(
            Effect.map((modelValue) =>
              modelValue === null ? [...THINKING_LEVELS] : getSupportedThinkingLevels(modelValue),
            ),
          ),
        getEntries,
        getSessionStats: () => trail.getStats(),
        getState: Effect.fn("getState")(function* () {
          const [name, { tailSeq }, snapshot, modelValue, thinkingLevelValue] = yield* Effect.all([
            trail.getName(),
            getEntries(),
            actor.snapshot,
            Ref.get(modelRef),
            Ref.get(thinkingLevelRef),
          ]);
          const state: HostStateProjection = {
            model: modelValue === null ? null : catalog.toWireInfo(modelValue),
            sessionId: agent.sessionId ?? null,
            state: wireStateOf(snapshot),
            tailSeq,
            thinkingLevel: thinkingLevelValue,
          };
          if (name !== undefined) {
            state.name = name;
          }
          return state;
        }),
        prompt: (text, images?) =>
          command(HostEvent.PromptRequested({ images, text })).pipe(Effect.asVoid),
        setAutoCompaction: (enabled) =>
          command(HostEvent.SetAutoCompactionRequested({ enabled })).pipe(Effect.asVoid),
        setFollowUpMode: (mode) =>
          Effect.sync(() => {
            agent.followUpMode = mode;
          }),
        setModel: (provider, modelId) =>
          command(HostEvent.SetModelRequested({ modelId, provider })).pipe(
            Effect.map((reply) => reply.model ?? null),
          ),
        setSessionName: (name) =>
          command(HostEvent.SetSessionNameRequested({ name })).pipe(Effect.asVoid),
        setSteeringMode: (mode) =>
          Effect.sync(() => {
            agent.steeringMode = mode;
          }),
        setThinkingLevel: (level) =>
          command(HostEvent.SetThinkingLevelRequested({ level })).pipe(
            Effect.map((reply) => reply.level ?? level),
          ),
        steer: (text) => command(HostEvent.SteerRequested({ text })).pipe(Effect.asVoid),
        threadId,
        get threadState() {
          return hostStateOf(actor.sync.snapshot());
        },
      } satisfies SessionHost;
    })();
  },
};
