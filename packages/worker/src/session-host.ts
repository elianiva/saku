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
 */

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
  type Session,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, ImageContent, Model, TextContent, UserMessage } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { SessionWireEvent, ThreadState, WireModelInfo } from "@saku/wire";

import { LocalEnv } from "./local-env.ts";
import { ModelCatalog } from "./model-catalog.ts";
import { buildTools } from "./tools.ts";
import { ThreadRegistry, threadSessionsRoot } from "./registry.ts";

const LANE = "main";

export type HostEventSink = (event: SessionWireEvent) => void;

export class SessionHostError extends Error {}

/** One thread's live session driver. Lazy: constructed on first touch. */
export class SessionHost {
  readonly threadId: string;
  readonly agent: Agent;
  readonly session: Session;
  readonly env: LocalEnv;
  readonly catalog: ModelCatalog;
  readonly registry: ThreadRegistry;

  private readonly sink: HostEventSink;
  private state: ThreadState;
  private currentModel: Model<Api> | null;
  private thinkingLevel: ThinkingLevel;
  private compactionSettings: CompactionSettings;
  private lastAssistantMessage: AssistantMessage | undefined;
  private running: Promise<void> | null = null;
  private compactionAbort: AbortController | null = null;
  private readonly unsubscribeAgent: () => void;

  private constructor(options: {
    threadId: string;
    agent: Agent;
    session: Session;
    env: LocalEnv;
    catalog: ModelCatalog;
    registry: ThreadRegistry;
    sink: HostEventSink;
    state: ThreadState;
    model: Model<Api> | null;
    thinkingLevel: ThinkingLevel;
    compactionSettings: CompactionSettings;
  }) {
    this.threadId = options.threadId;
    this.agent = options.agent;
    this.session = options.session;
    this.env = options.env;
    this.catalog = options.catalog;
    this.registry = options.registry;
    this.sink = options.sink;
    this.state = options.state;
    this.currentModel = options.model;
    this.thinkingLevel = options.thinkingLevel;
    this.compactionSettings = options.compactionSettings;
    this.unsubscribeAgent = this.agent.subscribe(this.handleAgentEvent);
  }

  /** Create the host for a thread: open/create the pi session, recover state. */
  static async create(options: {
    threadId: string;
    threadCwd: string;
    catalog: ModelCatalog;
    registry: ThreadRegistry;
    sink: HostEventSink;
  }): Promise<SessionHost> {
    const env = new LocalEnv(options.threadCwd);
    const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: threadSessionsRoot(options.threadId) });
    const existing = (await repo.list()).find((metadata) => metadata.id === options.threadId);
    const session = existing === undefined ? await repo.create({ id: options.threadId, cwd: options.threadCwd }) : await repo.open(existing);
    if (existing === undefined) {
      options.registry.update(options.threadId, { sessionId: options.threadId });
    }

    const entries = await branchEntries(session);
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
      const available = await options.catalog.available();
      model = available[0] ?? null;
    }

    // Recovery: an unfinished operation means the daemon died mid-run.
    const openOperations = await session.findOpenOperations(LANE, { limit: 1 });
    const initialState: ThreadState = openOperations.length > 0 ? "interrupted" : "idle";

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
      sessionId: options.threadId,
      steeringMode: "all",
      followUpMode: "all",
    });

    // Restore the live transcript; new sessions get their initial trail.
    if (entries.length > 0) {
      agent.state.messages = context.messages;
    } else {
      if (model !== null) {
        await session.appendEntry(
          { id: session.idGenerator.next(), type: "model_change", provider: model.provider, modelId: model.id },
          LANE,
        );
      }
      await session.appendEntry({ id: session.idGenerator.next(), type: "thinking_level_change", thinkingLevel }, LANE);
    }

    return new SessionHost({
      threadId: options.threadId,
      agent,
      session,
      env,
      catalog: options.catalog,
      registry: options.registry,
      sink: options.sink,
      state: initialState,
      model,
      thinkingLevel,
      compactionSettings: { ...DEFAULT_COMPACTION_SETTINGS },
    });
  }

  // -------------------------------------------------------------------------
  // Public query surface
  // -------------------------------------------------------------------------

  async getState(): Promise<{
    sessionId: string | null;
    name?: string;
    state: ThreadState;
    tailSeq: number;
    model: WireModelInfo | null;
    thinkingLevel: ThinkingLevel;
  }> {
    const [name, { tailSeq }] = await Promise.all([this.session.getName(), this.getEntries()]);
    return {
      sessionId: this.agent.sessionId ?? null,
      ...(name === undefined ? {} : { name }),
      state: this.state,
      tailSeq,
      model: this.currentModel === null ? null : this.catalog.toWireInfo(this.currentModel),
      thinkingLevel: this.thinkingLevel,
    };
  }

  get model(): Model<Api> | null {
    return this.currentModel;
  }

  get thinkingLevelValue(): ThinkingLevel {
    return this.thinkingLevel;
  }

  get threadState(): ThreadState {
    return this.state;
  }

  async getEntries(sinceSeq?: number): Promise<{ entries: Entry[]; tailSeq: number; leafId: string | null }> {
    const log = await this.session.getLog({ ...(sinceSeq === undefined ? {} : { afterSeq: sinceSeq }) });
    const entries = log.filter((item) => item.kind === "entry").map((item) => item.entry);
    const last = log[log.length - 1];
    const tailSeq = last === undefined ? (sinceSeq ?? 0) : last.seq;
    const leafId = await this.session.getLeafId();
    return { entries, tailSeq, leafId };
  }

  async getTree(): Promise<{ leafId: string | null; lanes: Array<{ lane: string; leafId: string | null }>; entries: Entry[] }> {
    const [lanes, leafId, log] = await Promise.all([
      this.session.getLanes(),
      this.session.getLeafId(),
      this.session.getLog(),
    ]);
    return {
      leafId,
      lanes,
      entries: log.filter((item) => item.kind === "entry").map((item) => item.entry),
    };
  }

  getMessages(): AgentMessage[] {
    return this.agent.state.messages;
  }

  getLastAssistantText(): string | null {
    const messages = this.agent.state.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message === undefined) continue;
      if (message.role === "assistant") {
        const text = message.content
          .filter((part): part is TextContent => part.type === "text")
          .map((part) => part.text)
          .join("");
        return text.length > 0 ? text : null;
      }
    }
    return null;
  }

  async getSessionStats() {
    return this.session.getStats();
  }

  async getSessionName(): Promise<string | undefined> {
    return this.session.getName();
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  /** Start a fresh run. Rejects while another run is in flight. */
  async prompt(text: string, images?: ReadonlyArray<unknown>): Promise<void> {
    if (this.running !== null) {
      throw new SessionHostError("agent is already processing");
    }
    this.assertModelReady();
    const content: Array<{ type: "text"; text: string } | ImageContent> = [{ type: "text", text }];
    if (images !== undefined && images.length > 0) {
      content.push(...(images as ImageContent[]));
    }
    const message: UserMessage = { role: "user", content, timestamp: Date.now() };
    await this.runRun(() => this.agent.prompt(message));
  }

  /** Queue a steer; when idle it starts a run like a prompt. */
  async steer(text: string): Promise<void> {
    if (this.running !== null) {
      this.assertModelReady();
      this.agent.steer(this.userMessage(text));
      return;
    }
    await this.prompt(text);
  }

  /** Queue a follow-up; when idle it starts a run like a prompt. */
  async followUp(text: string): Promise<void> {
    if (this.running !== null) {
      this.assertModelReady();
      this.agent.followUp(this.userMessage(text));
      return;
    }
    await this.prompt(text);
  }

  abort(): void {
    if (this.running === null) return;
    this.compactionAbort?.abort();
    this.agent.abort();
  }

  async compact(customInstructions?: string): Promise<unknown> {
    if (this.running !== null) {
      throw new SessionHostError("cannot compact while the agent is working");
    }
    return this.runCompaction("manual", customInstructions);
  }

  setAutoCompaction(enabled: boolean): void {
    this.compactionSettings = { ...this.compactionSettings, enabled };
  }

  async setModel(provider: string, modelId: string): Promise<Model<Api> | null> {
    const model = this.catalog.getModel(provider, modelId);
    if (model === undefined) {
      throw new SessionHostError(`unknown model: ${provider}/${modelId}`);
    }
    if (!(await this.catalog.hasAuth(provider))) {
      throw new SessionHostError(`no API key configured for ${provider}`);
    }
    this.currentModel = model;
    this.agent.state.model = model;
    const entry = await this.session.appendEntry(
      { id: this.session.idGenerator.next(), type: "model_change", provider, modelId },
      LANE,
    );
    this.sink({ type: "entry_appended", entry });
    await this.setThinkingLevel(this.thinkingLevel);
    return model;
  }

  async cycleModel(): Promise<Model<Api> | null> {
    const available = await this.catalog.available();
    if (available.length <= 1) return this.currentModel;
    const current = this.currentModel;
    const index = current === null ? -1 : available.findIndex((m) => m.provider === current.provider && m.id === current.id);
    const next = available[(index + 1) % available.length];
    if (next === undefined) return this.currentModel;
    await this.setModel(next.provider, next.id);
    return next;
  }

  getAvailableModels() {
    return this.catalog.allModels();
  }

  async getAvailableModelsWithAuth() {
    return this.catalog.available();
  }

  async getAvailableThinkingLevels(): Promise<ThinkingLevel[]> {
    if (this.currentModel === null) {
      return ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    }
    return getSupportedThinkingLevels(this.currentModel) as ThinkingLevel[];
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<ThinkingLevel> {
    const available = this.getAvailableThinkingLevelsSync();
    const effective = available.includes(level)
      ? level
      : (clampThinkingLevel(this.currentModel!, level) as ThinkingLevel);
    if (effective === this.thinkingLevel) {
      return effective;
    }
    this.thinkingLevel = effective;
    this.agent.state.thinkingLevel = effective;
    const entry = await this.session.appendEntry({ id: this.session.idGenerator.next(), type: "thinking_level_change", thinkingLevel: effective }, LANE);
    this.sink({ type: "entry_appended", entry });
    return effective;
  }

  async cycleThinkingLevel(): Promise<ThinkingLevel> {
    const levels = await this.getAvailableThinkingLevels();
    const index = levels.indexOf(this.thinkingLevel);
    const next = levels[(index + 1) % levels.length];
    if (next === undefined) return this.thinkingLevel;
    return this.setThinkingLevel(next);
  }

  async setSessionName(name: string): Promise<void> {
    await this.session.setName(name);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private getAvailableThinkingLevelsSync(): ThinkingLevel[] {
    if (this.currentModel === null) {
      return ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    }
    return getSupportedThinkingLevels(this.currentModel) as ThinkingLevel[];
  }

  private userMessage(text: string): AgentMessage {
    return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
  }

  private assertModelReady(): void {
    if (this.currentModel === null) {
      throw new SessionHostError("no model selected for this thread; use set_model first");
    }
  }

  /** Run one unit of agent work: working → settled → idle. */
  private async runRun(start: () => Promise<void>): Promise<void> {
    const run = (async () => {
      this.setState("working");
      try {
        await start();
        if (this.state === "working") {
          await this.maybeAutoCompact();
        }
        this.sink({ type: "settled" });
      } catch (error) {
        this.setState("crashed");
        throw error;
      } finally {
        this.running = null;
        if (this.state === "working") {
          this.setState("idle");
        }
      }
    })();
    this.running = run;
    await run;
  }

  private setState(state: ThreadState): void {
    this.state = state;
    this.registry.setState(this.threadId, state);
  }

  private async maybeAutoCompact(): Promise<void> {
    if (!this.compactionSettings.enabled) return;
    const assistant = this.lastAssistantMessage;
    if (assistant === undefined || this.currentModel === null) return;
    if (assistant.stopReason === "aborted" || assistant.stopReason === "error") return;
    const entries = await branchEntries(this.session);
    const context = buildSessionContext(entries);
    const estimate = estimateContextTokens(context.messages);
    if (shouldCompact(estimate.tokens, this.currentModel.contextWindow, this.compactionSettings)) {
      await this.runCompaction("threshold");
    }
  }

  private async runCompaction(
    reason: "manual" | "threshold" | "overflow",
    customInstructions?: string,
  ): Promise<unknown> {
    if (this.currentModel === null) {
      throw new SessionHostError("no model selected for this thread");
    }
    const entries = await branchEntries(this.session);
    const preparation = prepareCompaction(entries, this.compactionSettings);
    if (!preparation.ok) {
      throw preparation.error;
    }
    if (preparation.value === undefined) {
      return undefined;
    }

    this.compactionAbort = new AbortController();
    this.sink({ type: "compaction_start", reason });
    try {
      const result = await compact(
        preparation.value,
        this.catalog.piModels,
        this.currentModel,
        customInstructions,
        this.compactionAbort.signal,
        this.thinkingLevel,
      );
      if (!result.ok) {
        throw result.error;
      }
      const compacted = await this.session.appendEntry(
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
      );
      this.sink({ type: "entry_appended", entry: compacted });
      // Rebuild the live context from the compacted trail.
      const newEntries = await branchEntries(this.session);
      this.agent.state.messages = buildSessionContext(newEntries).messages;
      this.sink({ type: "compaction_end", reason, result: result.value, aborted: false });
      return result.value;
    } catch (error) {
      if (this.compactionAbort.signal.aborted) {
        this.sink({ type: "compaction_end", reason, result: undefined, aborted: true });
        return undefined;
      }
      this.sink({
        type: "compaction_end",
        reason,
        result: undefined,
        aborted: false,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.compactionAbort = null;
    }
  }

  // -- agent event handling --------------------------------------------------

  private handleAgentEvent = async (event: AgentEvent): Promise<void> => {
    if (event.type === "message_end") {
      const message = event.message;
      if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
        const entryId = await this.session.appendMessage(message);
        const entry = await this.session.getEntry(entryId);
        if (entry !== undefined) {
          this.sink({ type: "entry_appended", entry });
        }
      }
      if (message.role === "assistant") {
        this.lastAssistantMessage = message as AssistantMessage;
      }
    }

    const projected = projectAgentEvent(event);
    if (projected !== null) {
      this.sink(projected);
    }
  };

  /** Best-effort teardown when the daemon shuts down. */
  async dispose(): Promise<void> {
    this.unsubscribeAgent();
    if (this.running !== null) {
      this.agent.abort();
      try {
        await this.running;
      } catch {
        // Shutdown path: the run's failure is expected after abort.
      }
    }
    await this.env.cleanup();
  }
}

/** All entries on the main lane, in sequence order. */
const branchEntries = async (session: Session): Promise<Entry[]> => {
  const log = await session.getLog();
  return log.filter((item) => item.kind === "entry").map((item) => item.entry);
};

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
