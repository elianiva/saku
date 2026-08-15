/**
 * The wire's server fixture (hub-fixture.ts): the shipped `WireServer.make`
 * core — the same implementation the hub and the local daemon run — served
 * over a real WebSocket server via `listenWs`, with scripted in-memory
 * handlers standing in for the hub's registry, sessions, and skills store.
 *
 * The fixture is the shape `hub/wire-core.ts` adapts: `runHubCommand` and
 * `runSessionCommand` slots filled with fixture semantics (threads, lazy
 * per-thread sessions, skills), `core.broadcast` doing the fan-out.
 * Deliberately small — a fixture, not a product — but it exercises every
 * command the wire defines against the real server implementation, so the
 * protocol's contract is proven end to end.
 */

import { randomUUID } from "node:crypto";
import { Effect, Match, Schema as S } from "effect";
import { type WebSocket } from "ws";

import {
  AbortResponse,
  ArchiveThreadResponse,
  BranchResponse,
  CompactResponse,
  CreateThreadResponse,
  DeleteSkillResponse,
  DeleteThreadResponse,
  EventFrame,
  FollowUpResponse,
  GetAvailableModelsResponse,
  GetAvailableThinkingLevelsResponse,
  GetEntriesResponse,
  GetSessionStatsResponse,
  GetStateResponse,
  GetThreadResponse,
  ImportSkillResponse,
  ListSkillsResponse,
  ListThreadsResponse,
  PromptResponse,
  RenameThreadResponse,
  SetAutoCompactionResponse,
  SetFollowUpModeResponse,
  SetModelResponse,
  SetSessionNameResponse,
  SetSteeringModeResponse,
  SetThinkingLevelResponse,
  SteerResponse,
  THINKING_LEVELS,
  ThreadChanged,
  UnarchiveThreadResponse,
  type PiSessionCommand,
  type ProjectCommand,
  type ResponsePayload,
  type SessionCommand,
  type SkillCommand,
  type SkillInfo,
  type ThinkingLevel,
  type ThreadCommand,
  type ThreadInfo,
  type ThreadMode,
} from "../src/index.ts";
import { WireServer, listenWs, wsUrlOf } from "../src/server-core.ts";

/** The token the fixture accepts (clients use the same constant). */
export const TEST_TOKEN = "test-secret";
/** The single model the fixture's catalog knows. */
export const MOCK_MODEL = { provider: "mock", id: "m1", contextWindow: 128_000, reasoning: true };
/** Simulated run latency; prompts with this text are slow (timeout tests). */
const SLOW_MARKER = "slow";

/** The fixture's command failures (the core stringifies them into response errors). */
export class FixtureError extends S.TaggedError<FixtureError>()("FixtureError", {
  kind: S.Literals([
    "unknown_thread",
    "unknown_model",
    "busy",
    "empty_name",
    "unknown_entry",
    "unknown_skill",
    "pi_sessions_not_served",
    "projects_not_served",
  ]),
  message: S.String,
}) {}

interface ScriptedThread {
  id: string;
  name: string;
  cwd: string | null;
  mode: ThreadMode;
  autoName: boolean;
  sessionId: string | null;
  state: "idle" | "working";
  archivedAt: number | null;
  thinkingLevel: ThinkingLevel;
  nextSeq: number;
  entries: Array<{ seq: number; type: string; id: string }>;
  nameSet: string | null;
}

export interface HubFixture {
  /** The ws:// URL the fixture's server listens on. */
  readonly url: string;
  /** The command tags the handlers have served, in order. */
  readonly calls: () => readonly string[];
  /** Close every client connection (simulates a server restart). */
  readonly dropAll: () => Effect.Effect<void, never>;
  /** Send a raw frame to every connected client (malformed-frame tests). */
  readonly sendRaw: (text: string) => Effect.Effect<void, never>;
  /** Close the server for good. */
  readonly close: () => Effect.Effect<void, never>;
}

/** Start the fixture: the real server core on an ephemeral loopback port. */
export const startHubFixture = Effect.fn("startHubFixture")(function* () {
  const threads = new Map<string, ScriptedThread>();
  const skills = new Map<string, SkillInfo>();
  const sockets = new Set<WebSocket>();
  const calls: string[] = [];

  const record = (tag: string) => Effect.sync(() => calls.push(tag));

  const core = yield* WireServer.make({
    token: () => Effect.succeed(TEST_TOKEN),
    handlers: {
      runHubCommand: (command) =>
        record(command._tag).pipe(Effect.flatMap(() => runHubCommand(command))),
      runSessionCommand: (threadId, command) =>
        record(command._tag).pipe(Effect.flatMap(() => runSessionCommand(threadId, command))),
    },
  });

  const threadInfo = (thread: ScriptedThread) => ({
    id: thread.id,
    name: thread.name,
    cwd: thread.cwd,
    mode: thread.mode,
    state: thread.state,
    env: "ready",
    sessionId: thread.sessionId,
    tailSeq: thread.nextSeq - 1,
    archivedAt: thread.archivedAt,
  });

  const threadChanged = (thread: ScriptedThread) =>
    core.broadcast(ThreadChanged.make({ thread: threadInfo(thread) }));

  const findThread = (threadId: string) => {
    // Exact id first, then an unambiguous prefix (the real hub's contract).
    const exact = threads.get(threadId);
    if (exact !== undefined) return exact;
    const byPrefix = [...threads.values()].filter((t) => t.id.startsWith(threadId));
    return byPrefix.length === 1 ? byPrefix[0] : undefined;
  };

  const newThread = (input: {
    name: string;
    cwd?: string | undefined;
    mode?: ThreadMode | undefined;
    autoName?: boolean | undefined;
  }) => {
    const thread: ScriptedThread = {
      id: randomUUID().replaceAll("-", ""),
      name: input.name,
      cwd: input.mode === "sandbox" ? null : (input.cwd ?? null),
      mode: input.mode ?? "local",
      autoName: input.autoName === true,
      sessionId: null,
      state: "idle",
      archivedAt: null,
      thinkingLevel: "off",
      nextSeq: 1,
      entries: [],
      nameSet: null,
    };
    threads.set(thread.id, thread);
    return thread;
  };

  /** Settle one run: append the fake entry, broadcast it, go idle. */
  const settleRun = Effect.fn("settleRun")(function* (thread: ScriptedThread, _text: string) {
    const entry = { seq: thread.nextSeq++, type: "user_message", id: `e${thread.nextSeq - 1}` };
    thread.entries.push(entry);
    if (thread.sessionId === null) thread.sessionId = thread.id;
    yield* core.broadcast(
      EventFrame.make({ threadId: thread.id, event: { type: "entry_appended", entry } }),
    );
    thread.state = "idle";
    yield* threadChanged(thread);
    yield* core.broadcast(EventFrame.make({ threadId: thread.id, event: { type: "settled" } }));
  });

  const runHubCommand = (
    command: ThreadCommand | SkillCommand | PiSessionCommand | ProjectCommand,
  ) =>
    Match.value(command).pipe(
      Match.withReturnType<Effect.Effect<ResponsePayload, FixtureError, never>>(),
      Match.tagsExhaustive({
        list_threads: () =>
          Effect.succeed(
            ListThreadsResponse.make({ threads: [...threads.values()].map(threadInfo) }),
          ),
        create_thread: Effect.fn("create_thread")(function* (command) {
          const thread = newThread(command);
          // Broadcast before responding — the hub's ordering: consoles
          // see the change before the command resolves.
          yield* threadChanged(thread);
          return CreateThreadResponse.make({ thread: threadInfo(thread) });
        }),
        get_thread: Effect.fn("get_thread")(function* (command) {
          const thread = findThread(command.threadId);
          if (thread === undefined) {
            return yield* Effect.fail(
              new FixtureError({
                kind: "unknown_thread",
                message: `unknown thread: ${command.threadId}`,
              }),
            );
          }
          return GetThreadResponse.make({ thread: threadInfo(thread) });
        }),
        rename_thread: Effect.fn("rename_thread")(function* (command) {
          const thread = findThread(command.threadId);
          if (thread === undefined) {
            return yield* Effect.fail(
              new FixtureError({
                kind: "unknown_thread",
                message: `unknown thread: ${command.threadId}`,
              }),
            );
          }
          const name = command.name.trim();
          if (name.length === 0) {
            return yield* Effect.fail(
              new FixtureError({ kind: "empty_name", message: "name must not be empty" }),
            );
          }
          thread.name = name;
          yield* threadChanged(thread);
          return RenameThreadResponse.make({ thread: threadInfo(thread) });
        }),
        archive_thread: Effect.fn("archive_thread")(function* (command) {
          const thread = findThread(command.threadId);
          if (thread === undefined) {
            return yield* Effect.fail(
              new FixtureError({
                kind: "unknown_thread",
                message: `unknown thread: ${command.threadId}`,
              }),
            );
          }
          thread.archivedAt = Date.now();
          yield* threadChanged(thread);
          return ArchiveThreadResponse.make({ thread: threadInfo(thread) });
        }),
        unarchive_thread: Effect.fn("unarchive_thread")(function* (command) {
          const thread = findThread(command.threadId);
          if (thread === undefined) {
            return yield* Effect.fail(
              new FixtureError({
                kind: "unknown_thread",
                message: `unknown thread: ${command.threadId}`,
              }),
            );
          }
          thread.archivedAt = null;
          yield* threadChanged(thread);
          return UnarchiveThreadResponse.make({ thread: threadInfo(thread) });
        }),
        delete_thread: Effect.fn("delete_thread")(function* (command) {
          const thread = findThread(command.threadId);
          if (thread === undefined) {
            return yield* Effect.fail(
              new FixtureError({
                kind: "unknown_thread",
                message: `unknown thread: ${command.threadId}`,
              }),
            );
          }
          threads.delete(thread.id);
          yield* threadChanged(thread);
          return DeleteThreadResponse.make({});
        }),
        list_skills: () =>
          Effect.succeed(ListSkillsResponse.make({ skills: [...skills.values()] })),
        import_skill: (command) =>
          Effect.sync(() => {
            const skill: SkillInfo = {
              id: randomUUID().replaceAll("-", ""),
              name:
                command.source
                  .split("/")
                  .pop()
                  ?.replace(/\.git$/u, "") ?? "skill",
              scope: command.scope ?? "personal",
              source: command.source,
              version: null,
            };
            skills.set(skill.id, skill);
            return ImportSkillResponse.make({ skill });
          }),
        delete_skill: Effect.fn("delete_skill")(function* (command) {
          if (!skills.has(command.id)) {
            return yield* Effect.fail(
              new FixtureError({
                kind: "unknown_skill",
                message: `unknown skill: ${command.id}`,
              }),
            );
          }
          skills.delete(command.id);
          return DeleteSkillResponse.make({});
        }),
        // The fixture is the hub's shape: pi sessions live on the user's
        // machine, so only the local daemon serves these (mirror of the
        // daemon rejecting hub-only skills commands).
        list_pi_sessions: () =>
          Effect.fail(
            new FixtureError({
              kind: "pi_sessions_not_served",
              message: "pi sessions are served by the local daemon, not the hub",
            }),
          ),
        import_pi_session: () =>
          Effect.fail(
            new FixtureError({
              kind: "pi_sessions_not_served",
              message: "pi sessions are served by the local daemon, not the hub",
            }),
          ),
        // The fixture is the hub's shape: the project list scopes the local
        // daemon's pi-session window, so the hub rejects it too.
        list_projects: () =>
          Effect.fail(
            new FixtureError({
              kind: "projects_not_served",
              message: "projects are served by the local daemon, not the hub",
            }),
          ),
        add_project: () =>
          Effect.fail(
            new FixtureError({
              kind: "projects_not_served",
              message: "projects are served by the local daemon, not the hub",
            }),
          ),
        remove_project: () =>
          Effect.fail(
            new FixtureError({
              kind: "projects_not_served",
              message: "projects are served by the local daemon, not the hub",
            }),
          ),
        browse_project_dirs: () =>
          Effect.fail(
            new FixtureError({
              kind: "projects_not_served",
              message: "projects are served by the local daemon, not the hub",
            }),
          ),
      }),
    );

  const runSessionCommand = Effect.fn("runSessionCommand")(function* (
    threadId: string,
    command: SessionCommand,
  ) {
    const thread = findThread(threadId);
    if (thread === undefined) {
      return yield* Effect.fail(
        new FixtureError({ kind: "unknown_thread", message: `unknown thread: ${threadId}` }),
      );
    }
    return yield* Match.value(command).pipe(
      Match.withReturnType<Effect.Effect<ResponsePayload, FixtureError, never>>(),
      Match.tagsExhaustive({
        prompt: Effect.fn("prompt")(function* ({ text }) {
          if (thread.state === "working") {
            return yield* Effect.fail(
              new FixtureError({ kind: "busy", message: "agent is already processing" }),
            );
          }
          // A run is in flight from the moment the prompt is accepted.
          thread.state = "working";
          yield* threadChanged(thread);
          if (text.includes(SLOW_MARKER)) yield* Effect.sleep("300 millis");
          yield* settleRun(thread, text);
          return PromptResponse.make({});
        }),
        steer: Effect.fn("steer")(function* ({ text }) {
          if (thread.state === "working") return SteerResponse.make({});
          thread.state = "working";
          yield* threadChanged(thread);
          yield* settleRun(thread, text);
          return SteerResponse.make({});
        }),
        follow_up: Effect.fn("follow_up")(function* ({ text }) {
          if (thread.state === "working") return FollowUpResponse.make({});
          thread.state = "working";
          yield* threadChanged(thread);
          yield* settleRun(thread, text);
          return FollowUpResponse.make({});
        }),
        abort: Effect.fn("abort")(function* () {
          if (thread.state === "working") {
            thread.state = "idle";
            yield* core.broadcast(
              EventFrame.make({ threadId: thread.id, event: { type: "settled" } }),
            );
          }
          return AbortResponse.make({});
        }),
        set_steering_mode: () => Effect.succeed(SetSteeringModeResponse.make({})),
        set_follow_up_mode: () => Effect.succeed(SetFollowUpModeResponse.make({})),
        compact: Effect.fn("compact")(function* () {
          if (thread.state === "working") {
            return yield* Effect.fail(
              new FixtureError({
                kind: "busy",
                message: "cannot compact while the agent is working",
              }),
            );
          }
          return CompactResponse.make({
            result: { summary: "mock", tokensBefore: 0, retainedTail: [] },
          });
        }),
        set_auto_compaction: () => Effect.succeed(SetAutoCompactionResponse.make({})),
        get_available_models: () =>
          Effect.succeed(GetAvailableModelsResponse.make({ models: [MOCK_MODEL] })),
        set_model: Effect.fn("set_model")(function* ({ provider, modelId }) {
          if (provider !== MOCK_MODEL.provider || modelId !== MOCK_MODEL.id) {
            return yield* Effect.fail(
              new FixtureError({
                kind: "unknown_model",
                message: `unknown model: ${provider}/${modelId}`,
              }),
            );
          }
          return SetModelResponse.make({ model: MOCK_MODEL });
        }),
        get_available_thinking_levels: () =>
          Effect.succeed(GetAvailableThinkingLevelsResponse.make({ levels: THINKING_LEVELS })),
        set_thinking_level: ({ level }) =>
          Effect.sync(() => {
            thread.thinkingLevel = level;
            return SetThinkingLevelResponse.make({ level });
          }),
        get_entries: ({ sinceSeq }) =>
          Effect.succeed(
            GetEntriesResponse.make({
              entries: thread.entries.filter((e) => e.seq > (sinceSeq ?? 0)),
              tailSeq: thread.nextSeq - 1,
              leafId:
                thread.entries.length === 0 ? null : thread.entries[thread.entries.length - 1]!.id,
            }),
          ),
        branch: Effect.fn("branch")(function* ({ entryId }) {
          const entry = thread.entries.find((e) => e.id === entryId);
          if (entry === undefined) {
            return yield* Effect.fail(
              new FixtureError({
                kind: "unknown_entry",
                message: `unknown entry: ${entryId}`,
              }),
            );
          }
          return BranchResponse.make({ leafId: entry.id });
        }),
        get_session_stats: () =>
          Effect.succeed(GetSessionStatsResponse.make({ stats: { totalPromptTokens: 0 } })),
        set_session_name: ({ name }) =>
          Effect.sync(() => {
            thread.nameSet = name;
            return SetSessionNameResponse.make({});
          }),
        get_state: () =>
          Effect.succeed(
            GetStateResponse.make({
              state: {
                sessionId: thread.sessionId,
                ...(thread.nameSet === null ? {} : { name: thread.nameSet }),
                state: thread.state,
                tailSeq: thread.nextSeq - 1,
                model: MOCK_MODEL,
                thinkingLevel: thread.thinkingLevel,
              },
            }),
          ),
      }),
    );
  });

  const server = yield* listenWs({
    onConnection: (socket) => {
      sockets.add(socket);
      void Effect.runFork(
        Effect.scoped(core.runConnection(socket)).pipe(
          Effect.onExit(() => Effect.sync(() => sockets.delete(socket))),
        ),
      );
    },
    // Startup failures pass through untouched (the platform's raw error).
    onError: (error) => error,
  });

  const sendRaw = (text: string) =>
    Effect.sync(() => {
      for (const socket of sockets) {
        if (socket.readyState === socket.OPEN) socket.send(text);
      }
    });

  const dropAll = () =>
    Effect.sync(() => {
      for (const socket of sockets) socket.close();
    });

  const close = Effect.fn("close")(function* () {
    yield* dropAll();
    yield* Effect.callback<void>((resume) => {
      server.close(() => resume(Effect.void));
      return Effect.void;
    });
  });

  return {
    url: wsUrlOf(server),
    calls: () => [...calls],
    dropAll,
    sendRaw,
    close,
  };
});
