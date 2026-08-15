/**
 * The host machine (session-machine.ts): the effect-machine actor that
 * drives one thread's run lifecycle — Idle/Interrupted → Working/Compacting
 * → Idle, with a host-local `Crashed` state the daemon rebuilds on (the
 * wire only ever sees `ThreadState`, ADR 0001).
 *
 * Commands are OTP-style calls: reply-bearing events (`Event.reply` +
 * `actor.ask`), so a prompt's reply is deferred by the transition and
 * settled by the run's state-scoped effect when the run settles — the wire
 * keeps its blocking-prompt semantics. Validation failures are replies,
 * never actor defects; only storage/agent defects fail the handler, and
 * those surface as command failures too (`safeReply`).
 *
 * The machine's replies are the `HostReply` union (`reply_ok`/`reply_failed`
 * tagged structs), the dependencies live in `HostDeps`, and the durable
 * values (model, thinking level, name) live in the entry trail — this
 * module's helpers (run, compaction, auto-title) only read/write the trail
 * and the shared refs, never the wire.
 */

import { Effect, Match, Option, Ref, Result, Schema } from "effect";
import { Event, Machine, State, type DeferReplyResult, type ReplyResult } from "effect-machine";
import {
  buildSessionContext,
  compact,
  estimateContextTokens,
  prepareCompaction,
  shouldCompact,
  type Agent,
  type CompactionSettings,
  type Entry,
  type LogItem,
  type Session,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessage,
  ImageContent,
  Model,
  UserMessage,
} from "@earendil-works/pi-ai";
import {
  THINKING_LEVELS,
  ThinkingLevelSchema,
  type SessionWireEvent,
  type ThreadState,
  WireModelInfo,
} from "@saku/wire";

import type { ModelCatalogShape } from "./model-catalog.ts";
import type { HostRegistryShape, ThreadRecord } from "./registry.ts";
import { RegistryError } from "./registry-error.ts";
import { SessionHostError, messageOf, toSessionHostError } from "./session-host-error.ts";

/** The session's mutation lane (the wire's blocking-prompt semantics live on it). */
export const LANE = "main";

/** Push a wire-visible session event (the daemon/hub fans these out). */
export type HostEventSink = (event: SessionWireEvent) => void;

/** The host's lifecycle: the wire's `ThreadState` plus a host-local crash state. */
export type SessionHostState = ThreadState | "crashed";

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
export type HostStateV = Schema.Schema.Type<typeof HostState>;

/** The reply every command carries: the command's value, or the failure. */
const ReplyOk = Schema.TaggedStruct("reply_ok", {
  result: Schema.optional(Schema.Unknown), // compact result
  model: Schema.optional(Schema.Union([Schema.Null, WireModelInfo])),
  level: Schema.optional(ThinkingLevelSchema),
});
type ReplyOk = Schema.Schema.Type<typeof ReplyOk>;
const ReplyFailed = Schema.TaggedStruct("reply_failed", { message: Schema.String });
type ReplyFailed = Schema.Schema.Type<typeof ReplyFailed>;
const HostReply = Schema.Union([ReplyOk, ReplyFailed]);
export type HostReplyV = Schema.Schema.Type<typeof HostReply>;
export type { ReplyOk };

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
export type HostEventV = Schema.Schema.Type<typeof HostEvent>;
export type HostCommandEvent = Extract<
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
export const wireStateOf = (state: HostStateV) =>
  Match.value(state).pipe(
    Match.withReturnType<ThreadState>(),
    Match.when({ _tag: "Working" }, () => "working"),
    Match.when({ _tag: "Interrupted" }, () => "interrupted"),
    Match.orElse(() => "idle"),
  );

/** The wire-visible tag, plus the host-local `crashed` the daemon rebuilds on. */
export const hostStateOf = (state: HostStateV) =>
  state._tag === "Crashed" ? "crashed" : wireStateOf(state);

export interface HostDeps {
  readonly threadId: string;
  readonly agent: Agent;
  readonly session: Session;
  readonly catalog: ModelCatalogShape;
  readonly registry: HostRegistryShape;
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
const AUTO_TITLE_PROMPT = (text: string) =>
  `Generate a short but descriptive session title (5-12 words) for this conversation. Be specific enough to distinguish it from similar topics. Include key terms, file names, or project context when present. Reply ONLY with the title, no quotes, no punctuation, no extra text.\n\n${text.slice(0, 2000)}`;

/** The entry portion of a session log, in sequence order. */
export const entriesFromLog = (log: readonly LogItem[]) =>
  log
    .filter((item): item is Extract<LogItem, { kind: "entry" }> => item.kind === "entry")
    .map((item) => item.entry);

/** Apply a thinking level with model clamping; appends the trail entry. */
const applyThinkingLevel = Effect.fn("applyThinkingLevel")(function* (
  deps: HostDeps,
  level: ThinkingLevel,
) {
  const model = yield* Ref.get(deps.modelRef);
  const available =
    model === null ? [...THINKING_LEVELS] : (getSupportedThinkingLevels(model) as ThinkingLevel[]);
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
const applyModel = Effect.fn("applyModel")(function* (
  deps: HostDeps,
  provider: string,
  modelId: string,
) {
  const model = deps.catalog.getModel(provider, modelId);
  if (model === undefined) {
    return yield* Effect.fail(
      new SessionHostError({
        kind: "unknown_model",
        message: `unknown model: ${provider}/${modelId}`,
      }),
    );
  }
  if (!(yield* deps.catalog.hasAuth(provider))) {
    return yield* Effect.fail(
      new SessionHostError({ kind: "no_auth", message: `no API key configured for ${provider}` }),
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
const runCommand = Effect.fn("runCommand")(function* (
  deps: HostDeps,
  working: Extract<HostStateV, { readonly _tag: "Working" }>,
) {
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

const maybeAutoCompact = Effect.fn("maybeAutoCompact")(function* (deps: HostDeps) {
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
const runCompaction = Effect.fn("runCompaction")(function* (
  deps: HostDeps,
  reason: "manual" | "threshold" | "overflow",
  customInstructions?: string,
) {
  const model = yield* Ref.get(deps.modelRef);
  if (model === null) {
    return yield* Effect.fail(
      new SessionHostError({ kind: "no_model", message: "no model selected for this thread" }),
    );
  }
  const settings = yield* Ref.get(deps.compactionSettingsRef);
  const log = yield* Effect.tryPromise({
    try: () => deps.session.getLog(),
    catch: toSessionHostError,
  });
  const preparation = prepareCompaction(entriesFromLog(log), settings);
  if (!preparation.ok) {
    return yield* Effect.fail(
      new SessionHostError({
        kind: "compact_prepare",
        message: messageOf(preparation.error),
        cause: preparation.error,
      }),
    );
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
const maybeAutoTitle = Effect.fn("maybeAutoTitle")(function* (deps: HostDeps) {
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

/** The host machine type (the builder's result); `HostMachine.make` shapes one. */
type HostMachine = Machine.Machine<HostStateV, HostEventV, never, any, any, any>;

/**
 * The busy-state rejection for the three run commands: one reply per state
 * group (the messages are the same for prompt/steer/follow-up).
 */
const busyReply = (
  state: Extract<HostStateV, { readonly _tag: "Working" | "Compacting" | "Crashed" }>,
) =>
  ReplyFailed.make({
    message: Match.value(state).pipe(
      Match.tagsExhaustive({
        Working: () => "agent is already processing",
        Compacting: () => "cannot start a run while compacting",
        Crashed: () => "host crashed; retry",
      }),
    ),
  });

/**
 * The host machine builder: `Machine.make` plus the full transition table.
 * A plain builder, not a `Context.Service` — every thread's host builds its
 * own machine with thread-local deps and spawns it immediately (the
 * `SakuDaemon`-style services build the hosts, not the machines).
 */
const HostMachine = {
  make: (deps: HostDeps): HostMachine => {
    const machine = Machine.make({ state: HostState, event: HostEvent, initial: deps.initialState });

    return (
      machine
        .on([HostState.Idle, HostState.Interrupted], HostEvent.PromptRequested, ({ state, event }) =>
          startRun(deps, state, HostState.Working({ text: event.text, images: event.images })),
        )
        .on(
          [HostState.Working, HostState.Compacting, HostState.Crashed],
          HostEvent.PromptRequested,
          ({ state }) => Machine.reply(state, busyReply(state)),
        )
        .on([HostState.Idle, HostState.Interrupted], HostEvent.SteerRequested, ({ state, event }) =>
          startRun(deps, state, HostState.Working({ text: event.text })),
        )
        .on(
          [HostState.Working, HostState.Compacting, HostState.Crashed],
          HostEvent.SteerRequested,
          ({ state }) => Machine.reply(state, busyReply(state)),
        )
        .on(
          [HostState.Idle, HostState.Interrupted],
          HostEvent.FollowUpRequested,
          ({ state, event }) => startRun(deps, state, HostState.Working({ text: event.text })),
        )
        .on(
          [HostState.Working, HostState.Compacting, HostState.Crashed],
          HostEvent.FollowUpRequested,
          ({ state }) => Machine.reply(state, busyReply(state)),
        )
        // Abort settles the in-flight run; elsewhere it is a no-op.
        .on(HostState.Working, HostEvent.AbortRequested, ({ state }) =>
          Effect.gen(function* () {
            const compactionAbort = yield* Ref.get(deps.compactionAbortRef);
            if (Option.isSome(compactionAbort)) compactionAbort.value.abort();
            deps.agent.abort();
            return Machine.reply(state, ReplyOk.make({}));
          }),
        )
        .on(
          [HostState.Idle, HostState.Interrupted, HostState.Compacting, HostState.Crashed],
          HostEvent.AbortRequested,
          ({ state }) => Machine.reply(state, ReplyOk.make({})),
        )
        .on([HostState.Idle, HostState.Interrupted], HostEvent.CompactRequested, ({ event }) =>
          Machine.deferReply(HostState.Compacting({ customInstructions: event.customInstructions })),
        )
        .on(HostState.Working, HostEvent.CompactRequested, ({ state }) =>
          Machine.reply(
            state,
            ReplyFailed.make({ message: "cannot compact while the agent is working" }),
          ),
        )
        .on(HostState.Compacting, HostEvent.CompactRequested, ({ state }) =>
          Machine.reply(state, ReplyFailed.make({ message: "already compacting" })),
        )
        .on(HostState.Crashed, HostEvent.CompactRequested, ({ state }) =>
          Machine.reply(state, ReplyFailed.make({ message: "host crashed; retry" })),
        )
        // Config commands are valid in every state (the trail is the source of truth).
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
              return Machine.reply(state, ReplyOk.make({}));
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
              }).pipe(Effect.map(() => ReplyOk.make({}))),
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
                  ReplyOk.make({ model: model === null ? null : deps.catalog.toWireInfo(model) }),
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
              applyThinkingLevel(deps, event.level).pipe(
                Effect.map((level) => ReplyOk.make({ level })),
              ),
            ),
        )
        // Run lifecycle: the state-scoped effects settle their own replies.
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
        .spawn(HostState.Working, ({ self, state }) =>
          Effect.gen(function* () {
            yield* runCommand(deps, state);
            yield* self.reply(ReplyOk.make({}));
            yield* self.send(HostEvent.RunFinished);
          }).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                yield* self.reply(ReplyFailed.make({ message: messageOf(error) }));
                yield* self.send(HostEvent.RunFailed({ message: messageOf(error) }));
              }),
            ),
          ),
        )
        .spawn(HostState.Compacting, ({ self, state }) =>
          Effect.gen(function* () {
            const result = yield* runCompaction(deps, "manual", state.customInstructions);
            yield* self.reply(ReplyOk.make({ result }));
            yield* self.send(HostEvent.CompactFinished({ result }));
          }).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                yield* self.reply(ReplyFailed.make({ message: messageOf(error) }));
                yield* self.send(HostEvent.CompactFailed({ message: messageOf(error) }));
              }),
            ),
          ),
        )
    );
  },
};

/** Start a run from idle/interrupted: model check, then defer the reply to the run. */
const startRun = Effect.fn("startRun")(function* <S extends HostStateV>(
  deps: HostDeps,
  state: S,
  working: Extract<HostStateV, { readonly _tag: "Working" }>,
) {
  const model = yield* Ref.get(deps.modelRef);
  if (model === null) {
    return Machine.reply(
      state,
      ReplyFailed.make({ message: "no model selected for this thread; use set_model first" }),
    );
  }
  yield* deps.pushState("working");
  return Machine.deferReply(working);
});

/** Run IO and always answer the call with a reply — handlers never fail the actor. */
const safeReply = Effect.fn("safeReply")(function* <S extends HostStateV>(
  state: S,
  work: Effect.Effect<HostReplyV, unknown, never>,
) {
  const outcome = yield* work.pipe(Effect.result);
  return Result.isFailure(outcome)
    ? Machine.reply(state, ReplyFailed.make({ message: messageOf(outcome.failure) }))
    : Machine.reply(state, outcome.success);
});

export { HostState, HostEvent, HostMachine };
