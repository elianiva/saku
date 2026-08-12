/**
 * Session host (session-host.ts): the worker's in-process driver of a
 * thread's pi session — the server-side analogue of the shell's
 * `AgentSession`, but built directly on pi-agent-core's `Agent`, `Session`,
 * `JsonlSessionRepo`, and compaction helpers.
 *
 * Responsibilities:
 * - durable entries (append on message_end, model/thinking changes, compaction)
 * - wire event projection (pi's AgentEvent minus agent_end, partials stripped)
 * - run lifecycle: working → settled → idle; interrupted/crashed recovery
 * - auto-compaction (threshold) and manual compaction
 * - model / thinking-level switching with entry persistence
 *
 * The command surface is Effect-typed. Pi's `Agent`/`Session` API is
 * promise-based, so every pi call crosses the boundary through
 * `Effect.tryPromise` (the same seam lutra draws around its promise codecs);
 * saku's own services (registry, catalog, filesystem) are composed directly.
 * State that crosses fibers (command effects, the agent's event callbacks)
 * lives in `Ref`s.
 */

import { Effect, Fiber, FileSystem, Option, Ref, Result, Schema } from "effect";
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
  type LogItem,
  type Session,
  type SessionStats,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, ImageContent, Model, UserMessage } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { THINKING_LEVELS, type SessionWireEvent, type ThreadState, type WireModelInfo } from "@saku/wire";

import { LocalEnv } from "./local-env.ts";
import { ModelCatalog, type ModelCatalogShape } from "./model-catalog.ts";
import { buildTools } from "./tools.ts";
import { ThreadRegistry, RegistryError, type ThreadRecord, type ThreadRegistryShape } from "./registry.ts";
import { getThreadSessionsRoot } from "./paths.ts";

const LANE = "main";

/**
 * The host's internal lifecycle: the wire's `ThreadState` plus a host-local
 * `crashed` recovery state. `crashed` never crosses the wire — the registry
 * and `get_state` see `idle`, and the daemon rebuilds the host on the next
 * command (ADR 0001: a failed run is an error response, not a thread state).
 */
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

/** Auto-title: the pinned lightweight model that names quick-started threads (CONTEXT.md: Auto-title). */
const AUTO_TITLE_PROVIDER = "opencode-go";
const AUTO_TITLE_MODEL = "deepseek-v4-flash";

/** The extension's title prompt, copied verbatim (auto-session-title.ts). */
const AUTO_TITLE_PROMPT = (text: string): string =>
  `Generate a short but descriptive session title (5-12 words) for this conversation. Be specific enough to distinguish it from similar topics. Include key terms, file names, or project context when present. Reply ONLY with the title, no quotes, no punctuation, no extra text.\n\n${text.slice(0, 2000)}`;

/** The entry portion of a session log, in sequence order. */
const entriesFromLog = (log: readonly LogItem[]): Entry[] =>
  log.filter((item): item is Extract<LogItem, { kind: "entry" }> => item.kind === "entry").map((item) => item.entry);

/**
 * One thread's live session driver. Lazy: constructed on first touch.
 * All commands are Effects; pi's promise API crosses at `Effect.tryPromise`.
 */
export class SessionHost {
  readonly threadId: string;
  readonly agent: Agent;
  readonly session: Session;
  readonly env: LocalEnv;
  readonly catalog: ModelCatalogShape;
  readonly registry: ThreadRegistryShape;

  private readonly sink: HostEventSink;
  private readonly onRecordChanged: ((record: ThreadRecord) => void) | undefined;
  private readonly stateRef: Ref.Ref<HostState>;
  private readonly modelRef: Ref.Ref<Model<Api> | null>;
  private readonly thinkingLevelRef: Ref.Ref<ThinkingLevel>;
  private readonly compactionSettingsRef: Ref.Ref<CompactionSettings>;
  private readonly lastAssistantRef: Ref.Ref<AssistantMessage | undefined>;
  /** The in-flight run's fiber, tracked so `abort`/`dispose` can settle it. */
  private readonly runningRef: Ref.Ref<Option.Option<Fiber.Fiber<void, SessionHostError>>>;
  private readonly compactionAbortRef: Ref.Ref<Option.Option<AbortController>>;
  private readonly unsubscribeAgent: () => void;

  private constructor(options: {
    threadId: string;
    agent: Agent;
    session: Session;
    env: LocalEnv;
    catalog: ModelCatalogShape;
    registry: ThreadRegistryShape;
    sink: HostEventSink;
    /** Fired after the host renames its own registry record (auto-title). */
    onRecordChanged?: (record: ThreadRecord) => void;
    stateRef: Ref.Ref<HostState>;
    modelRef: Ref.Ref<Model<Api> | null>;
    thinkingLevelRef: Ref.Ref<ThinkingLevel>;
    compactionSettingsRef: Ref.Ref<CompactionSettings>;
    lastAssistantRef: Ref.Ref<AssistantMessage | undefined>;
    runningRef: Ref.Ref<Option.Option<Fiber.Fiber<void, SessionHostError>>>;
    compactionAbortRef: Ref.Ref<Option.Option<AbortController>>;
  }) {
    this.threadId = options.threadId;
    this.agent = options.agent;
    this.session = options.session;
    this.env = options.env;
    this.catalog = options.catalog;
    this.registry = options.registry;
    this.sink = options.sink;
    this.onRecordChanged = options.onRecordChanged;
    this.stateRef = options.stateRef;
    this.modelRef = options.modelRef;
    this.thinkingLevelRef = options.thinkingLevelRef;
    this.compactionSettingsRef = options.compactionSettingsRef;
    this.lastAssistantRef = options.lastAssistantRef;
    this.runningRef = options.runningRef;
    this.compactionAbortRef = options.compactionAbortRef;
    this.unsubscribeAgent = this.agent.subscribe(this.handleAgentEvent);
  }

  /** Create the host for a thread: open/create the pi session, recover state. */
  static create(options: {
    threadId: string;
    /** The registry record; its sessionId is back-filled when null (first touch). */
    record: ThreadRecord;
    fs: FileSystem.FileSystem;
    catalog: ModelCatalogShape;
    registry: ThreadRegistryShape;
    sink: HostEventSink;
    onRecordChanged?: (record: ThreadRecord) => void;
  }): Effect.Effect<SessionHost, SessionHostError | RegistryError, never> {
    return Effect.gen(function* () {
      const { threadId, record, fs } = options;
      const env = new LocalEnv(record.cwd, fs);
      // The repo creates the sessions directory itself on first create.
      const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: getThreadSessionsRoot(threadId) });
      const found = (yield* Effect.tryPromise({ try: () => repo.list(), catch: toSessionHostError })).find(
        (metadata) => metadata.id === threadId,
      );
      const session =
        found === undefined
          ? yield* Effect.tryPromise({
              try: () => repo.create({ id: threadId, cwd: record.cwd }),
              catch: toSessionHostError,
            })
          : yield* Effect.tryPromise({ try: () => repo.open(found), catch: toSessionHostError });
      if (record.sessionId === null) {
        // First touch (or a crash between repo creation and the registry update
        // on a previous boot): back-fill the stable session id.
        yield* options.registry.update(threadId, { sessionId: threadId }).pipe(Effect.mapError(toSessionHostError));
      }

      const entries = entriesFromLog(yield* Effect.tryPromise({ try: () => session.getLog(), catch: toSessionHostError }));
      const context = buildSessionContext(entries);

      // Recover model + thinking level from the entry trail. A fresh thread
      // defaults to the first available model (pi's own habit: a new session
      // starts with the default from auth.json), persisted as a model_change
      // entry below.
      let model: Model<Api> | null = null;
      let thinkingLevel: ThinkingLevel = "off";
      for (const entry of entries) {
        if (entry.type === "model_change") {
          model = options.catalog.getModel(entry.provider, entry.modelId) ?? null;
        } else if (entry.type === "thinking_level_change") {
          thinkingLevel = entry.thinkingLevel as ThinkingLevel;
        }
      }
      if (model === null) {
        const available = yield* Effect.tryPromise({
          try: () => options.catalog.models.getAvailable(),
          catch: toSessionHostError,
        });
        model = available[0] ?? null;
      }

      // Recovery: an unfinished operation means the daemon died mid-run.
      const openOperations = yield* Effect.tryPromise({
        try: () => session.findOpenOperations(LANE, { limit: 1 }),
        catch: toSessionHostError,
      });
      const initialState: HostState = openOperations.length > 0 ? "interrupted" : "idle";

      const agent = new Agent({
        initialState: {
          systemPrompt: "",
          ...(model === null ? {} : { model }),
          thinkingLevel,
          tools: buildTools(env),
        },
        convertToLlm,
        streamFn: (modelForRequest, streamContext, streamOptions) =>
          options.catalog.models.streamSimple(modelForRequest, streamContext, streamOptions),
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
                { id: session.idGenerator.next(), type: "model_change", provider: model.provider, modelId: model.id },
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

      return new SessionHost({
        threadId,
        agent,
        session,
        env,
        catalog: options.catalog,
        registry: options.registry,
        sink: options.sink,
        ...(options.onRecordChanged === undefined ? {} : { onRecordChanged: options.onRecordChanged }),
        stateRef: yield* Ref.make<HostState>(initialState),
        modelRef: yield* Ref.make(model),
        thinkingLevelRef: yield* Ref.make(thinkingLevel),
        compactionSettingsRef: yield* Ref.make({ ...DEFAULT_COMPACTION_SETTINGS }),
        lastAssistantRef: yield* Ref.make<AssistantMessage | undefined>(undefined),
        runningRef: yield* Ref.make<Option.Option<Fiber.Fiber<void, SessionHostError>>>(Option.none()),
        compactionAbortRef: yield* Ref.make<Option.Option<AbortController>>(Option.none()),
      });
    });
  }

  // -------------------------------------------------------------------------
  // Public query surface
  // -------------------------------------------------------------------------

  getState(): Effect.Effect<
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
  > {
    return Effect.gen({ self: this }, function* () {
      const [name, { tailSeq }] = yield* Effect.all([
        Effect.tryPromise({ try: () => this.session.getName(), catch: toSessionHostError }),
        this.getEntriesInternal(),
      ]);
      const [state, model, thinkingLevel] = yield* Effect.all([
        Ref.get(this.stateRef),
        Ref.get(this.modelRef),
        Ref.get(this.thinkingLevelRef),
      ]);
      return {
        sessionId: this.agent.sessionId ?? null,
        ...(name === undefined ? {} : { name }),
        // A crashed host looks idle on the wire; the next command rebuilds it.
        state: state === "crashed" ? "idle" : state,
        tailSeq,
        model: model === null ? null : this.catalog.toWireInfo(model),
        thinkingLevel,
      };
    });
  }

  get threadState(): HostState {
    return Ref.getUnsafe(this.stateRef);
  }

  getEntries(
    sinceSeq?: number,
  ): Effect.Effect<{ entries: Entry[]; tailSeq: number; leafId: string | null }, SessionHostError, never> {
    return this.getEntriesInternal(sinceSeq);
  }

  private getEntriesInternal(
    sinceSeq?: number,
  ): Effect.Effect<{ entries: Entry[]; tailSeq: number; leafId: string | null }, SessionHostError, never> {
    return Effect.gen({ self: this }, function* () {
      const log = yield* Effect.tryPromise({
        try: () => this.session.getLog({ ...(sinceSeq === undefined ? {} : { afterSeq: sinceSeq }) }),
        catch: toSessionHostError,
      });
      const entries = entriesFromLog(log);
      const last = log[log.length - 1];
      const tailSeq = last === undefined ? (sinceSeq ?? 0) : last.seq;
      const leafId = yield* Effect.tryPromise({ try: () => this.session.getLeafId(), catch: toSessionHostError });
      return { entries, tailSeq, leafId };
    });
  }

  getSessionStats(): Effect.Effect<SessionStats, SessionHostError, never> {
    return Effect.tryPromise({ try: () => this.session.getStats(), catch: toSessionHostError });
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  /** Start a fresh run. Rejects while another run is in flight. */
  prompt(text: string, images?: ReadonlyArray<unknown>): Effect.Effect<void, SessionHostError, never> {
    return this.promptInternal(text, images);
  }

  private promptInternal(
    text: string,
    images?: ReadonlyArray<unknown>,
  ): Effect.Effect<void, SessionHostError, never> {
    return Effect.gen({ self: this }, function* () {
      if (Option.isSome(yield* Ref.get(this.runningRef))) {
        return yield* Effect.fail(new SessionHostError({ message: "agent is already processing" }));
      }
      yield* this.assertModelReady();
      const content: Array<{ type: "text"; text: string } | ImageContent> = [{ type: "text", text }];
      if (images !== undefined && images.length > 0) {
        content.push(...(images as ImageContent[]));
      }
      const message: UserMessage = { role: "user", content, timestamp: Date.now() };
      yield* this.runRun(Effect.tryPromise({ try: () => this.agent.prompt(message), catch: toSessionHostError }));
    });
  }

  /** Queue a steer; when idle it starts a run like a prompt. */
  steer(text: string): Effect.Effect<void, SessionHostError, never> {
    return Effect.gen({ self: this }, function* () {
      if (Option.isSome(yield* Ref.get(this.runningRef))) {
        yield* this.assertModelReady();
        this.agent.steer(this.userMessage(text));
        return;
      }
      yield* this.promptInternal(text);
    });
  }

  /** Queue a follow-up; when idle it starts a run like a prompt. */
  followUp(text: string): Effect.Effect<void, SessionHostError, never> {
    return Effect.gen({ self: this }, function* () {
      if (Option.isSome(yield* Ref.get(this.runningRef))) {
        yield* this.assertModelReady();
        this.agent.followUp(this.userMessage(text));
        return;
      }
      yield* this.promptInternal(text);
    });
  }

  abort(): Effect.Effect<void, never> {
    return Effect.gen({ self: this }, function* () {
      if (Option.isNone(yield* Ref.get(this.runningRef))) return;
      const compactionAbort = yield* Ref.get(this.compactionAbortRef);
      if (Option.isSome(compactionAbort)) compactionAbort.value.abort();
      this.agent.abort();
    });
  }

  compact(customInstructions?: string): Effect.Effect<unknown, SessionHostError, never> {
    return Effect.gen({ self: this }, function* () {
      if (Option.isSome(yield* Ref.get(this.runningRef))) {
        return yield* Effect.fail(new SessionHostError({ message: "cannot compact while the agent is working" }));
      }
      return yield* this.runCompaction("manual", customInstructions);
    });
  }

  setAutoCompaction(enabled: boolean): Effect.Effect<void, never> {
    return Ref.update(this.compactionSettingsRef, (settings) => ({ ...settings, enabled }));
  }

  setModel(provider: string, modelId: string): Effect.Effect<Model<Api> | null, SessionHostError, never> {
    return this.setModelInternal(provider, modelId);
  }

  private setModelInternal(provider: string, modelId: string): Effect.Effect<Model<Api> | null, SessionHostError, never> {
    return Effect.gen({ self: this }, function* () {
      const model = this.catalog.getModel(provider, modelId);
      if (model === undefined) {
        return yield* Effect.fail(new SessionHostError({ message: `unknown model: ${provider}/${modelId}` }));
      }
      if (!(yield* this.catalog.hasAuth(provider))) {
        return yield* Effect.fail(new SessionHostError({ message: `no API key configured for ${provider}` }));
      }
      yield* Ref.set(this.modelRef, model);
      this.agent.state.model = model;
      const entry = yield* Effect.tryPromise({
        try: () => this.session.appendEntry({ id: this.session.idGenerator.next(), type: "model_change", provider, modelId }, LANE),
        catch: toSessionHostError,
      });
      this.sink({ type: "entry_appended", entry });
      yield* this.setThinkingLevelInternal(yield* Ref.get(this.thinkingLevelRef));
      return model;
    });
  }

  getAvailableThinkingLevels(): Effect.Effect<ThinkingLevel[], never> {
    return Ref.get(this.modelRef).pipe(
      Effect.map((model) =>
        model === null ? [...THINKING_LEVELS] : (getSupportedThinkingLevels(model) as ThinkingLevel[]),
      ),
    );
  }

  setThinkingLevel(level: ThinkingLevel): Effect.Effect<ThinkingLevel, SessionHostError, never> {
    return this.setThinkingLevelInternal(level);
  }

  private setThinkingLevelInternal(level: ThinkingLevel): Effect.Effect<ThinkingLevel, SessionHostError, never> {
    return Effect.gen({ self: this }, function* () {
      const model = yield* Ref.get(this.modelRef);
      const available =
        model === null ? [...THINKING_LEVELS] : (getSupportedThinkingLevels(model) as ThinkingLevel[]);
      let effective = level;
      if (!available.includes(level) && model !== null) {
        effective = clampThinkingLevel(model, level) as ThinkingLevel;
      }
      const current = yield* Ref.get(this.thinkingLevelRef);
      if (effective === current) return effective;
      yield* Ref.set(this.thinkingLevelRef, effective);
      this.agent.state.thinkingLevel = effective;
      const entry = yield* Effect.tryPromise({
        try: () =>
          this.session.appendEntry(
            { id: this.session.idGenerator.next(), type: "thinking_level_change", thinkingLevel: effective },
            LANE,
          ),
        catch: toSessionHostError,
      });
      this.sink({ type: "entry_appended", entry });
      return effective;
    });
  }

  setSessionName(name: string): Effect.Effect<void, SessionHostError, never> {
    return Effect.tryPromise({ try: () => this.session.setName(name), catch: toSessionHostError });
  }

  /**
   * Move the session's leaf to a past entry; the next prompt parents onto it,
   * forking the thread (pi's own vocabulary: `moveLane`). Idle threads only.
   */
  branch(entryId: string): Effect.Effect<string | null, SessionHostError, never> {
    return Effect.gen({ self: this }, function* () {
      if (Option.isSome(yield* Ref.get(this.runningRef))) {
        return yield* Effect.fail(new SessionHostError({ message: "cannot branch while the agent is working" }));
      }
      const entry = yield* Effect.tryPromise({ try: () => this.session.getEntry(entryId), catch: toSessionHostError });
      if (entry === undefined) {
        return yield* Effect.fail(new SessionHostError({ message: `unknown entry: ${entryId}` }));
      }
      yield* Effect.tryPromise({ try: () => this.session.moveLane(LANE, entryId), catch: toSessionHostError });
      return entryId;
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private userMessage(text: string): AgentMessage {
    return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
  }

  private assertModelReady(): Effect.Effect<void, SessionHostError, never> {
    return Ref.get(this.modelRef).pipe(
      Effect.flatMap((model) =>
        model === null
          ? Effect.fail(new SessionHostError({ message: "no model selected for this thread; use set_model first" }))
          : Effect.void,
      ),
    );
  }

  private setState(state: HostState): Effect.Effect<void, never> {
    return Effect.gen({ self: this }, function* () {
      yield* Ref.set(this.stateRef, state);
      // `crashed` is host-local; the registry (and therefore the wire) sees idle.
      yield* this.registry.setState(this.threadId, state === "crashed" ? "idle" : state);
    });
  }

  /**
   * Run one unit of agent work: working → settled → idle. The run executes
   * on its own fiber so `abort` can settle it; failures crash the host.
   */
  private runRun(start: Effect.Effect<void, SessionHostError, never>): Effect.Effect<void, SessionHostError, never> {
    return Effect.gen({ self: this }, function* () {
      yield* this.setState("working");
      const fiber = yield* Effect.forkChild(
        Effect.gen({ self: this }, function* () {
          yield* start;
          if ((yield* Ref.get(this.stateRef)) === "working") {
            yield* this.maybeAutoCompact();
          }
          this.sink({ type: "settled" });
          // Best-effort, never fails or delays the run or the prompt response.
          yield* this.maybeAutoTitle().pipe(Effect.ignore);
        }).pipe(
          Effect.catch((error) =>
            this.setState("crashed").pipe(Effect.andThen(Effect.fail(error))),
          ),
          Effect.ensuring(
            Effect.gen({ self: this }, function* () {
              yield* Ref.set(this.runningRef, Option.none());
              if ((yield* Ref.get(this.stateRef)) === "working") {
                yield* this.setState("idle");
              }
            }),
          ),
        ),
      );
      yield* Ref.set(this.runningRef, Option.some(fiber));
      yield* Fiber.join(fiber);
    });
  }

  /**
   * Auto-title (CONTEXT.md: Auto-title): after a quick-started thread's first
   * settled run, generate a title with the pinned model and upgrade the
   * registry name to `title — snippet`. Cleared on success or user rename
   * (`rename_thread`), so a failed attempt retries on the next run and user
   * names are never rewritten.
   */
  private maybeAutoTitle(): Effect.Effect<void, SessionHostError | RegistryError, never> {
    return Effect.gen({ self: this }, function* () {
      const record = yield* this.registry.get(this.threadId);
      if (Option.isNone(record) || record.value.nameAuto !== true) return;
      const model = this.catalog.getModel(AUTO_TITLE_PROVIDER, AUTO_TITLE_MODEL);
      if (model === undefined) return;
      if (!(yield* this.catalog.hasAuth(AUTO_TITLE_PROVIDER))) return;

      const response = yield* Effect.tryPromise({
        try: () =>
          this.catalog.models.completeSimple(model, {
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

      const updated = yield* this.registry.update(this.threadId, {
        name: `${title} — ${record.value.name}`,
        nameAuto: false,
      });
      if (Option.isSome(updated)) {
        this.onRecordChanged?.(updated.value);
      }
    });
  }

  private maybeAutoCompact(): Effect.Effect<void, SessionHostError, never> {
    return Effect.gen({ self: this }, function* () {
      const settings = yield* Ref.get(this.compactionSettingsRef);
      if (!settings.enabled) return;
      const assistant = yield* Ref.get(this.lastAssistantRef);
      const model = yield* Ref.get(this.modelRef);
      if (assistant === undefined || model === null) return;
      if (assistant.stopReason === "aborted" || assistant.stopReason === "error") return;
      const log = yield* Effect.tryPromise({ try: () => this.session.getLog(), catch: toSessionHostError });
      const context = buildSessionContext(entriesFromLog(log));
      const estimate = estimateContextTokens(context.messages);
      if (shouldCompact(estimate.tokens, model.contextWindow, settings)) {
        yield* this.runCompaction("threshold");
      }
    });
  }

  private runCompaction(
    reason: "manual" | "threshold" | "overflow",
    customInstructions?: string,
  ): Effect.Effect<unknown, SessionHostError, never> {
    return Effect.gen({ self: this }, function* () {
      const model = yield* Ref.get(this.modelRef);
      if (model === null) {
        return yield* Effect.fail(new SessionHostError({ message: "no model selected for this thread" }));
      }
      const settings = yield* Ref.get(this.compactionSettingsRef);
      const log = yield* Effect.tryPromise({ try: () => this.session.getLog(), catch: toSessionHostError });
      const preparation = prepareCompaction(entriesFromLog(log), settings);
      if (!preparation.ok) {
        return yield* Effect.fail(toSessionHostError(preparation.error));
      }
      if (preparation.value === undefined) {
        return undefined;
      }
      const prepared = preparation.value;

      const abortController = new AbortController();
      yield* Ref.set(this.compactionAbortRef, Option.some(abortController));
      this.sink({ type: "compaction_start", reason });
      const thinkingLevel = yield* Ref.get(this.thinkingLevelRef);
      const outcome = yield* Effect.result(
        Effect.gen({ self: this }, function* () {
          const result = yield* Effect.tryPromise({
            try: () =>
              compact(
                prepared,
                this.catalog.models,
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
              this.session.appendEntry(
                {
                  id: this.session.idGenerator.next(),
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
          this.sink({ type: "entry_appended", entry: compacted });
          // Rebuild the live context from the compacted trail.
          const newLog = yield* Effect.tryPromise({ try: () => this.session.getLog(), catch: toSessionHostError });
          this.agent.state.messages = buildSessionContext(entriesFromLog(newLog)).messages;
          this.sink({ type: "compaction_end", reason, result: result.value, aborted: false });
          return result.value;
        }).pipe(Effect.ensuring(Ref.set(this.compactionAbortRef, Option.none()))),
      );
      if (Result.isFailure(outcome)) {
        if (abortController.signal.aborted) {
          this.sink({ type: "compaction_end", reason, result: undefined, aborted: true });
          return undefined;
        }
        this.sink({
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
  }

  // -- agent event handling --------------------------------------------------

  /**
   * Pi's subscription contract is a promise-returning callback; the effect
   * pipeline runs at that boundary (the only `runPromise` in this class).
   */
  private handleAgentEvent = (event: AgentEvent, _signal: AbortSignal): Promise<void> =>
    Effect.runPromise(this.handleAgentEventEffect(event));

  private handleAgentEventEffect(event: AgentEvent): Effect.Effect<void, SessionHostError, never> {
    return Effect.gen({ self: this }, function* () {
      if (event.type === "message_end") {
        const message = event.message;
        if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
          const entryId = yield* Effect.tryPromise({
            try: () => this.session.appendMessage(message),
            catch: toSessionHostError,
          });
          const entry = yield* Effect.tryPromise({ try: () => this.session.getEntry(entryId), catch: toSessionHostError });
          if (entry !== undefined) {
            this.sink({ type: "entry_appended", entry });
          }
        }
        if (message.role === "assistant") {
          yield* Ref.set(this.lastAssistantRef, message as AssistantMessage);
        }
      }

      const projected = projectAgentEvent(event);
      if (projected !== null) {
        this.sink(projected);
      }
    });
  }

  /** Best-effort teardown when the daemon shuts down. */
  dispose(): Effect.Effect<void, never> {
    return Effect.gen({ self: this }, function* () {
      this.unsubscribeAgent();
      const running = yield* Ref.get(this.runningRef);
      if (Option.isSome(running)) {
        this.agent.abort();
        // Shutdown path: the run's failure is expected after abort.
        yield* Fiber.await(running.value).pipe(Effect.ignore);
      }
      yield* Effect.promise(() => this.env.cleanup());
    }).pipe(Effect.ignore);
  }
}

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
