/**
 * Session host (session-host.ts): the worker's driver of one thread's pi
 * session — the server-side analogue of the shell's `AgentSession`, built
 * directly on pi-agent-core's `Agent` + `Session`, with the session's trail
 * on DO storage (`DoSessionRepo` over the `KvStore` seam, ADR 0001).
 *
 * The host is an `effect-machine` actor:
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
 *               Working, like the class it replaces)
 * ```
 *
 * Commands are OTP-style calls: reply-bearing events (`Event.reply` +
 * `actor.ask`), so a prompt's reply is deferred by the transition and settled
 * by the run's state-scoped effect when the run settles — the wire keeps its
 * blocking-prompt semantics. Validation failures are replies, never actor
 * defects; only storage/agent defects fail the handler, and those surface as
 * command failures too (`safeReply`).
 *
 * Durable values (model, thinking level, name) live in the entry trail and
 * are recovered at `create`; volatile config (compaction settings, the last
 * assistant message, the compaction abort controller) lives in `Ref`s, as in
 * the wire client. The state schema itself is plain tags, so persisting the
 * machine's state in a Durable Object later is trivial.
 */

import { Duration, Effect, Option, Ref, Result, Schema } from "effect";
import { Event, Machine, State, type DeferReplyResult, type ReplyResult } from "effect-machine";
import {
  Agent,
  DEFAULT_COMPACTION_SETTINGS,
  buildSessionContext,
  compact,
  convertToLlm,
  estimateContextTokens,
  prepareCompaction,
  shouldCompact,
  type AgentEvent,
  type AgentMessage,
  type CompactionSettings,
  type Entry,
  type ExecutionEnv,
  type LogItem,
  type Session,
  type SessionStats,
  type StreamFn,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  ImageContent,
  Model,
  UserMessage,
} from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  THINKING_LEVELS,
  ThinkingLevelSchema,
  type SessionWireEvent,
  type ThreadState,
  WireModelInfo,
} from "@saku/wire";

import { DoSessionRepo } from "./do-session.ts";
import type { KvStore } from "@saku/store";
import type { ModelCatalogShape } from "./model-catalog.ts";
import { buildTools } from "./tools.ts";
import { RegistryError } from "./registry-error.ts";
import type { ThreadRecord, ThreadRegistryShape } from "./registry.ts";
import { LocalEnv } from "@saku/env";

const LANE = "main";

/** The host's lifecycle: the wire's `ThreadState` plus a host-local crash state. */
export type HostState = ThreadState | "crashed";

export type HostEventSink = (event: SessionWireEvent) => void;

export class SessionHostError extends Schema.TaggedError<SessionHostError>()("SessionHostError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

/** Map any pi-boundary failure onto the host's error type. */
const toSessionHostError = (error: unknown): SessionHostError =>
  error instanceof SessionHostError
    ? error
    : new SessionHostError({
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      });

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// ---------------------------------------------------------------------------
// The machine's state and events
// ---------------------------------------------------------------------------

/** Host lifecycle. `Crashed` never crosses the wire (ADR 0001). */
const HostState = State({
  Idle: {},
  /** The trail had an open operation at boot; the previous run died mid-flight. */
  Interrupted: {},
  /** A run (prompt/steer/follow-up) is in flight; the state carries the run. */
  Working: { text: Schema.String, images: Schema.optional(Schema.Array(Schema.Unknown)) },
  /** A manual compaction is in flight; the state carries its instructions. */
  Compacting: { customInstructions: Schema.optional(Schema.String) },
  /** A run failed; the next command rebuilds the host. */
  Crashed: { message: Schema.String },
});
type HostStateV = Schema.Schema.Type<typeof HostState>;

/** The reply every command carries: ok + the command's value, or the failure. */
const HostReply = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.optional(Schema.String),
  result: Schema.optional(Schema.Unknown),
  model: Schema.optional(Schema.Union([Schema.Null, WireModelInfo])),
  level: Schema.optional(ThinkingLevelSchema),
});
type HostReplyV = Schema.Schema.Type<typeof HostReply>;

const okReply = (extra: Partial<HostReplyV> = {}): HostReplyV => ({ ok: true, ...extra });
const failReply = (message: string): HostReplyV => ({ ok: false, message });

/** Everything the machine reacts to: commands (reply-bearing) and run/compaction lifecycle events. */
const HostEvent = Event({
  PromptRequested: Event.reply(
    { text: Schema.String, images: Schema.optional(Schema.Array(Schema.Unknown)) },
    HostReply,
  ),
  SteerRequested: Event.reply({ text: Schema.String }, HostReply),
  FollowUpRequested: Event.reply({ text: Schema.String }, HostReply),
  AbortRequested: Event.reply({}, HostReply),
  CompactRequested: Event.reply({ customInstructions: Schema.optional(Schema.String) }, HostReply),
  SetAutoCompactionRequested: Event.reply({ enabled: Schema.Boolean }, HostReply),
  SetModelRequested: Event.reply({ provider: Schema.String, modelId: Schema.String }, HostReply),
  SetThinkingLevelRequested: Event.reply({ level: ThinkingLevelSchema }, HostReply),
  SetSessionNameRequested: Event.reply({ name: Schema.String }, HostReply),
  // Internal lifecycle events, sent by the state-scoped run/compaction effects.
  RunFinished: {},
  RunFailed: { message: Schema.String },
  CompactFinished: { result: Schema.Unknown },
  CompactFailed: { message: Schema.String },
});
type HostEventV = Schema.Schema.Type<typeof HostEvent>;
type HostCommandEvent = Extract<
  HostEventV,
  {
    readonly _tag:
      | "PromptRequested"
      | "SteerRequested"
      | "FollowUpRequested"
      | "AbortRequested"
      | "CompactRequested"
      | "SetAutoCompactionRequested"
      | "SetModelRequested"
      | "SetThinkingLevelRequested"
      | "SetSessionNameRequested";
  }
>;
/** The wire-visible state of a machine state (crashed and compacting look idle). */
const wireStateOf = (state: HostStateV): ThreadState => {
  switch (state._tag) {
    case "Working":
      return "working";
    case "Interrupted":
      return "interrupted";
    default:
      return "idle";
  }
};

/** The wire-visible tag, plus the host-local `crashed` the daemon rebuilds on. */
const hostStateOf = (state: HostStateV): HostState =>
  state._tag === "Crashed" ? "crashed" : wireStateOf(state);

// ---------------------------------------------------------------------------
// Dependencies shared by the machine and the host value
// ---------------------------------------------------------------------------

interface HostDeps {
  readonly threadId: string;
  readonly agent: Agent;
  readonly session: Session;
  readonly catalog: ModelCatalogShape;
  readonly registry: ThreadRegistryShape;
  readonly sink: HostEventSink;
  readonly onRecordChanged: ((record: ThreadRecord) => void) | undefined;
  readonly modelRef: Ref.Ref<Model<Api> | null>;
  readonly thinkingLevelRef: Ref.Ref<ThinkingLevel>;
  readonly compactionSettingsRef: Ref.Ref<CompactionSettings>;
  readonly lastAssistantRef: Ref.Ref<AssistantMessage | undefined>;
  readonly compactionAbortRef: Ref.Ref<Option.Option<AbortController>>;
  /** The machine's initial state (Idle, or Interrupted after crash recovery). */
  readonly initialState: HostStateV;
  /** Push the wire-visible state into the registry (crashed → idle). */
  readonly pushState: (state: ThreadState) => Effect.Effect<void, never>;
}

/** Auto-title: the pinned lightweight model that names quick-started threads (CONTEXT.md: Auto-title). */
const AUTO_TITLE_PROVIDER = "opencode-go";
const AUTO_TITLE_MODEL = "deepseek-v4-flash";

/** The extension's title prompt, copied verbatim (auto-session-title.ts). */
const AUTO_TITLE_PROMPT = (text: string): string =>
  `Generate a short but descriptive session title (5-12 words) for this conversation. Be specific enough to distinguish it from similar topics. Include key terms, file names, or project context when present. Reply ONLY with the title, no quotes, no punctuation, no extra text.\n\n${text.slice(0, 2000)}`;

/** The entry portion of a session log, in sequence order. */
const entriesFromLog = (log: readonly LogItem[]): Entry[] =>
  log
    .filter((item): item is Extract<LogItem, { kind: "entry" }> => item.kind === "entry")
    .map((item) => item.entry);

// ---------------------------------------------------------------------------
// Shared session operations (used by transition handlers and state effects)
// ---------------------------------------------------------------------------

/** Apply a thinking level with model clamping; appends the trail entry. */
const applyThinkingLevel = (
  deps: HostDeps,
  level: ThinkingLevel,
): Effect.Effect<ThinkingLevel, SessionHostError, never> =>
  Effect.gen(function* () {
    const model = yield* Ref.get(deps.modelRef);
    const available =
      model === null
        ? [...THINKING_LEVELS]
        : (getSupportedThinkingLevels(model) as ThinkingLevel[]);
    let effective = level;
    if (!available.includes(level) && model !== null) {
      effective = clampThinkingLevel(model, level) as ThinkingLevel;
    }
    const current = yield* Ref.get(deps.thinkingLevelRef);
    if (effective === current) return effective;
    yield* Ref.set(deps.thinkingLevelRef, effective);
    deps.agent.state.thinkingLevel = effective;
    const entry = yield* Effect.tryPromise({
      try: () =>
        deps.session.appendEntry(
          {
            id: deps.session.idGenerator.next(),
            type: "thinking_level_change",
            thinkingLevel: effective,
          },
          LANE,
        ),
      catch: toSessionHostError,
    });
    deps.sink({ type: "entry_appended", entry });
    return effective;
  });

/** Set the thread's model: catalog + auth checks, trail entry, thinking re-clamp. */
const applyModel = (
  deps: HostDeps,
  provider: string,
  modelId: string,
): Effect.Effect<Model<Api> | null, SessionHostError, never> =>
  Effect.gen(function* () {
    const model = deps.catalog.getModel(provider, modelId);
    if (model === undefined) {
      return yield* Effect.fail(
        new SessionHostError({ message: `unknown model: ${provider}/${modelId}` }),
      );
    }
    if (!(yield* deps.catalog.hasAuth(provider))) {
      return yield* Effect.fail(
        new SessionHostError({ message: `no API key configured for ${provider}` }),
      );
    }
    yield* Ref.set(deps.modelRef, model);
    deps.agent.state.model = model;
    const entry = yield* Effect.tryPromise({
      try: () =>
        deps.session.appendEntry(
          { id: deps.session.idGenerator.next(), type: "model_change", provider, modelId },
          LANE,
        ),
      catch: toSessionHostError,
    });
    deps.sink({ type: "entry_appended", entry });
    yield* applyThinkingLevel(deps, yield* Ref.get(deps.thinkingLevelRef));
    return model;
  });

/** One unit of agent work: the run, then auto-compaction, settled, auto-title. */
const runCommand = (
  deps: HostDeps,
  working: Extract<HostStateV, { readonly _tag: "Working" }>,
): Effect.Effect<void, SessionHostError, never> =>
  Effect.gen(function* () {
    const content: Array<{ type: "text"; text: string } | ImageContent> = [
      { type: "text", text: working.text },
    ];
    if (working.images !== undefined && working.images.length > 0) {
      content.push(...(working.images as ImageContent[]));
    }
    const message: UserMessage = { role: "user", content, timestamp: Date.now() };
    yield* Effect.tryPromise({ try: () => deps.agent.prompt(message), catch: toSessionHostError });
    yield* maybeAutoCompact(deps);
    deps.sink({ type: "settled" });
    // Best-effort, never fails or delays the run or the prompt response.
    yield* maybeAutoTitle(deps).pipe(Effect.ignore);
  });

const maybeAutoCompact = (deps: HostDeps): Effect.Effect<void, SessionHostError, never> =>
  Effect.gen(function* () {
    const settings = yield* Ref.get(deps.compactionSettingsRef);
    if (!settings.enabled) return;
    const assistant = yield* Ref.get(deps.lastAssistantRef);
    const model = yield* Ref.get(deps.modelRef);
    if (assistant === undefined || model === null) return;
    if (assistant.stopReason === "aborted" || assistant.stopReason === "error") return;
    const log = yield* Effect.tryPromise({
      try: () => deps.session.getLog(),
      catch: toSessionHostError,
    });
    const context = buildSessionContext(entriesFromLog(log));
    const estimate = estimateContextTokens(context.messages);
    if (shouldCompact(estimate.tokens, model.contextWindow, settings)) {
      yield* runCompaction(deps, "threshold");
    }
  });

/**
 * Compaction, manual or threshold. Aborts settle as success with `undefined`
 * (the run continues); real failures propagate.
 */
const runCompaction = (
  deps: HostDeps,
  reason: "manual" | "threshold" | "overflow",
  customInstructions?: string,
): Effect.Effect<unknown, SessionHostError, never> =>
  Effect.gen(function* () {
    const model = yield* Ref.get(deps.modelRef);
    if (model === null) {
      return yield* Effect.fail(
        new SessionHostError({ message: "no model selected for this thread" }),
      );
    }
    const settings = yield* Ref.get(deps.compactionSettingsRef);
    const log = yield* Effect.tryPromise({
      try: () => deps.session.getLog(),
      catch: toSessionHostError,
    });
    const preparation = prepareCompaction(entriesFromLog(log), settings);
    if (!preparation.ok) {
      return yield* Effect.fail(toSessionHostError(preparation.error));
    }
    if (preparation.value === undefined) {
      return undefined;
    }
    const prepared = preparation.value;

    const abortController = new AbortController();
    yield* Ref.set(deps.compactionAbortRef, Option.some(abortController));
    deps.sink({ type: "compaction_start", reason });
    const thinkingLevel = yield* Ref.get(deps.thinkingLevelRef);
    const outcome = yield* Effect.result(
      Effect.gen(function* () {
        const result = yield* Effect.tryPromise({
          try: () =>
            compact(
              prepared,
              deps.catalog.models,
              model,
              customInstructions,
              abortController.signal,
              thinkingLevel,
            ),
          catch: toSessionHostError,
        });
        if (!result.ok) {
          return yield* Effect.fail(toSessionHostError(result.error));
        }
        const compacted = yield* Effect.tryPromise({
          try: () =>
            deps.session.appendEntry(
              {
                id: deps.session.idGenerator.next(),
                type: "compaction",
                summary: result.value.summary,
                retainedTail: result.value.retainedTail,
                tokensBefore: result.value.tokensBefore,
                ...(result.value.details === undefined ? {} : { details: result.value.details }),
                ...(result.value.usage === undefined ? {} : { usage: result.value.usage }),
              },
              LANE,
            ),
          catch: toSessionHostError,
        });
        deps.sink({ type: "entry_appended", entry: compacted });
        // Rebuild the live context from the compacted trail.
        const newLog = yield* Effect.tryPromise({
          try: () => deps.session.getLog(),
          catch: toSessionHostError,
        });
        deps.agent.state.messages = buildSessionContext(entriesFromLog(newLog)).messages;
        deps.sink({ type: "compaction_end", reason, result: result.value, aborted: false });
        return result.value;
      }).pipe(Effect.ensuring(Ref.set(deps.compactionAbortRef, Option.none()))),
    );
    if (Result.isFailure(outcome)) {
      if (abortController.signal.aborted) {
        deps.sink({ type: "compaction_end", reason, result: undefined, aborted: true });
        return undefined;
      }
      deps.sink({
        type: "compaction_end",
        reason,
        result: undefined,
        aborted: false,
        errorMessage: outcome.failure.message,
      });
      return yield* Effect.fail(outcome.failure);
    }
    return outcome.success;
  });

/** Auto-title: name quick-started threads after their first settled run. */
const maybeAutoTitle = (
  deps: HostDeps,
): Effect.Effect<void, SessionHostError | RegistryError, never> =>
  Effect.gen(function* () {
    const record = yield* deps.registry.get(deps.threadId);
    if (Option.isNone(record) || record.value.nameAuto !== true) return;
    const model = deps.catalog.getModel(AUTO_TITLE_PROVIDER, AUTO_TITLE_MODEL);
    if (model === undefined) return;
    if (!(yield* deps.catalog.hasAuth(AUTO_TITLE_PROVIDER))) return;

    const response = yield* Effect.tryPromise({
      try: () =>
        deps.catalog.models.completeSimple(model, {
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: AUTO_TITLE_PROMPT(record.value.name) }],
              timestamp: Date.now(),
            },
          ],
        }),
      catch: toSessionHostError,
    });
    const title = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("")
      .trim()
      .replace(/^["']|["']$/g, "")
      .slice(0, 80);
    if (title.length === 0) return;

    const updated = yield* deps.registry.update(deps.threadId, {
      name: `${title} — ${record.value.name}`,
      nameAuto: false,
    });
    if (Option.isSome(updated)) {
      deps.onRecordChanged?.(updated.value);
    }
  });

// ---------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------

type HostMachine = Machine.Machine<HostStateV, HostEventV, never, any, any, any>;

const makeHostMachine = (deps: HostDeps): HostMachine => {
  const machine = Machine.make({ state: HostState, event: HostEvent, initial: deps.initialState });

  // -- runs: idle/interrupted start one; busy states reject ------------------
  // effect-machine registers one event per transition, so the three run
  // commands are spelled out over the four state groups.
  return (
    machine
      .on([HostState.Idle, HostState.Interrupted], HostEvent.PromptRequested, ({ state, event }) =>
        startRun(deps, state, HostState.Working({ text: event.text, images: event.images })),
      )
      .on(HostState.Working, HostEvent.PromptRequested, ({ state }) =>
        Machine.reply(state, failReply("agent is already processing")),
      )
      .on(HostState.Compacting, HostEvent.PromptRequested, ({ state }) =>
        Machine.reply(state, failReply("cannot start a run while compacting")),
      )
      .on(HostState.Crashed, HostEvent.PromptRequested, ({ state }) =>
        Machine.reply(state, failReply("host crashed; retry")),
      )
      .on([HostState.Idle, HostState.Interrupted], HostEvent.SteerRequested, ({ state, event }) =>
        startRun(deps, state, HostState.Working({ text: event.text })),
      )
      .on(HostState.Working, HostEvent.SteerRequested, ({ state }) =>
        Machine.reply(state, failReply("agent is already processing")),
      )
      .on(HostState.Compacting, HostEvent.SteerRequested, ({ state }) =>
        Machine.reply(state, failReply("cannot start a run while compacting")),
      )
      .on(HostState.Crashed, HostEvent.SteerRequested, ({ state }) =>
        Machine.reply(state, failReply("host crashed; retry")),
      )
      .on(
        [HostState.Idle, HostState.Interrupted],
        HostEvent.FollowUpRequested,
        ({ state, event }) => startRun(deps, state, HostState.Working({ text: event.text })),
      )
      .on(HostState.Working, HostEvent.FollowUpRequested, ({ state }) =>
        Machine.reply(state, failReply("agent is already processing")),
      )
      .on(HostState.Compacting, HostEvent.FollowUpRequested, ({ state }) =>
        Machine.reply(state, failReply("cannot start a run while compacting")),
      )
      .on(HostState.Crashed, HostEvent.FollowUpRequested, ({ state }) =>
        Machine.reply(state, failReply("host crashed; retry")),
      )
      // -- abort: settle the in-flight run; elsewhere it is a no-op --------------
      .on(HostState.Working, HostEvent.AbortRequested, ({ state }) =>
        Effect.gen(function* () {
          const compactionAbort = yield* Ref.get(deps.compactionAbortRef);
          if (Option.isSome(compactionAbort)) compactionAbort.value.abort();
          deps.agent.abort();
          return Machine.reply(state, okReply());
        }),
      )
      .on(
        [HostState.Idle, HostState.Interrupted, HostState.Compacting, HostState.Crashed],
        HostEvent.AbortRequested,
        ({ state }) => Machine.reply(state, okReply()),
      )
      // -- manual compaction -----------------------------------------------------
      .on([HostState.Idle, HostState.Interrupted], HostEvent.CompactRequested, ({ event }) =>
        Machine.deferReply(HostState.Compacting({ customInstructions: event.customInstructions })),
      )
      .on(HostState.Working, HostEvent.CompactRequested, ({ state }) =>
        Machine.reply(state, failReply("cannot compact while the agent is working")),
      )
      .on(HostState.Compacting, HostEvent.CompactRequested, ({ state }) =>
        Machine.reply(state, failReply("already compacting")),
      )
      .on(HostState.Crashed, HostEvent.CompactRequested, ({ state }) =>
        Machine.reply(state, failReply("host crashed; retry")),
      )
      // -- config commands: valid in every state (the trail is the source of truth)
      .on(
        [
          HostState.Idle,
          HostState.Interrupted,
          HostState.Working,
          HostState.Compacting,
          HostState.Crashed,
        ],
        HostEvent.SetAutoCompactionRequested,
        ({ state, event }) =>
          Effect.gen(function* () {
            yield* Ref.update(deps.compactionSettingsRef, (settings) => ({
              ...settings,
              enabled: event.enabled,
            }));
            return Machine.reply(state, okReply());
          }),
      )
      .on(
        [
          HostState.Idle,
          HostState.Interrupted,
          HostState.Working,
          HostState.Compacting,
          HostState.Crashed,
        ],
        HostEvent.SetSessionNameRequested,
        ({ state, event }) =>
          safeReply(
            state,
            Effect.tryPromise({
              try: () => deps.session.setName(event.name),
              catch: toSessionHostError,
            }).pipe(Effect.map(() => okReply())),
          ),
      )
      .on(
        [
          HostState.Idle,
          HostState.Interrupted,
          HostState.Working,
          HostState.Compacting,
          HostState.Crashed,
        ],
        HostEvent.SetModelRequested,
        ({ state, event }) =>
          safeReply(
            state,
            applyModel(deps, event.provider, event.modelId).pipe(
              Effect.map((model) =>
                okReply({ model: model === null ? null : deps.catalog.toWireInfo(model) }),
              ),
            ),
          ),
      )
      .on(
        [
          HostState.Idle,
          HostState.Interrupted,
          HostState.Working,
          HostState.Compacting,
          HostState.Crashed,
        ],
        HostEvent.SetThinkingLevelRequested,
        ({ state, event }) =>
          safeReply(
            state,
            applyThinkingLevel(deps, event.level).pipe(Effect.map((level) => okReply({ level }))),
          ),
      )
      // -- run lifecycle: the state-scoped effects settle their own replies -------
      .on(HostState.Working, HostEvent.RunFinished, () =>
        Effect.gen(function* () {
          yield* deps.pushState("idle");
          return HostState.Idle;
        }),
      )
      .on(HostState.Working, HostEvent.RunFailed, ({ event }) =>
        Effect.gen(function* () {
          yield* deps.pushState("idle");
          return HostState.Crashed({ message: event.message });
        }),
      )
      .on(HostState.Compacting, HostEvent.CompactFinished, () =>
        Effect.gen(function* () {
          yield* deps.pushState("idle");
          return HostState.Idle;
        }),
      )
      .on(HostState.Compacting, HostEvent.CompactFailed, () =>
        Effect.gen(function* () {
          yield* deps.pushState("idle");
          return HostState.Idle;
        }),
      )
      // -- the run: entered only via a run command; the entry event carries it ----
      .spawn(HostState.Working, ({ self, state }) =>
        Effect.gen(function* () {
          yield* runCommand(deps, state);
          yield* self.reply(okReply());
          yield* self.send(HostEvent.RunFinished);
        }).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              yield* self.reply(failReply(messageOf(error)));
              yield* self.send(HostEvent.RunFailed({ message: messageOf(error) }));
            }),
          ),
        ),
      )
      .spawn(HostState.Compacting, ({ self, state }) =>
        Effect.gen(function* () {
          const result = yield* runCompaction(deps, "manual", state.customInstructions);
          yield* self.reply(okReply({ result }));
          yield* self.send(HostEvent.CompactFinished({ result }));
        }).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              yield* self.reply(failReply(messageOf(error)));
              yield* self.send(HostEvent.CompactFailed({ message: messageOf(error) }));
            }),
          ),
        ),
      )
  );
};

/** Start a run from idle/interrupted: model check, then defer the reply to the run. */
const startRun = <S extends HostStateV>(
  deps: HostDeps,
  state: S,
  working: Extract<HostStateV, { readonly _tag: "Working" }>,
): Effect.Effect<
  ReplyResult<S, HostReplyV> | DeferReplyResult<Extract<HostStateV, { readonly _tag: "Working" }>>,
  never,
  never
> =>
  Effect.gen(function* () {
    const model = yield* Ref.get(deps.modelRef);
    if (model === null) {
      return Machine.reply(
        state,
        failReply("no model selected for this thread; use set_model first"),
      );
    }
    yield* deps.pushState("working");
    return Machine.deferReply(working);
  });

/** Run IO and always answer the call with a reply — handlers never fail the actor. */
const safeReply = <S extends HostStateV>(
  state: S,
  work: Effect.Effect<HostReplyV, unknown, never>,
): Effect.Effect<ReplyResult<S, HostReplyV>, never, never> =>
  Effect.gen(function* () {
    const outcome = yield* work.pipe(Effect.result);
    return Result.isFailure(outcome)
      ? Machine.reply(state, failReply(messageOf(outcome.failure)))
      : Machine.reply(state, outcome.success);
  });

// ---------------------------------------------------------------------------
// The host value
// ---------------------------------------------------------------------------

export interface SessionHost {
  readonly threadId: string;
  /** The host-local lifecycle tag; the daemon rebuilds a crashed host. */
  readonly threadState: HostState;
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
  /** The thread's session trail on the `KvStore` seam (DO storage in production). */
  readonly kv: KvStore;
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
  ): Effect.Effect<SessionHost, SessionHostError | RegistryError, never> {
    return Effect.gen(function* () {
      const { threadId, record, kv, catalog, registry, env } = options;
      // The trail: the session's mutations on DO storage (the daemon passes
      // a file-backed store; a Durable Object passes its own storage).
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

      const command = (
        event: HostCommandEvent,
      ): Effect.Effect<HostReplyV, SessionHostError, never> =>
        actor.ask(event).pipe(
          Effect.flatMap((reply) =>
            reply.ok
              ? Effect.succeed(reply)
              : Effect.fail(new SessionHostError({ message: reply.message ?? "command failed" })),
          ),
          Effect.mapError((error) => toSessionHostError(error)),
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
          yield* Effect.promise(() => env.cleanup());
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
                new SessionHostError({ message: "cannot branch while the agent is working" }),
              );
            }
            const entry = yield* Effect.tryPromise({
              try: () => session.getEntry(entryId),
              catch: toSessionHostError,
            });
            if (entry === undefined) {
              return yield* Effect.fail(
                new SessionHostError({ message: `unknown entry: ${entryId}` }),
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

/** Pi's agent events: durable appends on message_end, then wire projection. */
const handleAgentEvent = (
  deps: HostDeps,
  event: AgentEvent,
): Effect.Effect<void, SessionHostError, never> =>
  Effect.gen(function* () {
    if (event.type === "message_end") {
      const message = event.message;
      if (
        message.role === "user" ||
        message.role === "assistant" ||
        message.role === "toolResult"
      ) {
        const entryId = yield* Effect.tryPromise({
          try: () => deps.session.appendMessage(message),
          catch: toSessionHostError,
        });
        const entry = yield* Effect.tryPromise({
          try: () => deps.session.getEntry(entryId),
          catch: toSessionHostError,
        });
        if (entry !== undefined) {
          deps.sink({ type: "entry_appended", entry });
        }
      }
      if (message.role === "assistant") {
        yield* Ref.set(deps.lastAssistantRef, message as AssistantMessage);
      }
    }

    const projected = projectAgentEvent(event);
    if (projected !== null) {
      deps.sink(projected);
    }
  });

/**
 * Project a pi AgentEvent onto the wire: `agent_end` is replaced by saku's
 * `settled`; `message_update` drops the cumulative `partial` snapshot.
 */
const projectAgentEvent = (event: AgentEvent): SessionWireEvent | null => {
  if (event.type === "agent_end") return null;
  if (event.type === "message_update") {
    const assistantMessageEvent = event.assistantMessageEvent;
    if ("partial" in assistantMessageEvent) {
      const { partial: _partial, ...rest } = assistantMessageEvent;
      void _partial;
      return { ...event, assistantMessageEvent: rest } as SessionWireEvent;
    }
    return event as SessionWireEvent;
  }
  return event as SessionWireEvent;
};
