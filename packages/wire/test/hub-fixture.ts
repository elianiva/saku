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
import type { WebSocket } from "ws";

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
} from "../src/index.ts";
import type {
  ArchiveThreadCommand,
  BranchCommand,
  CreateThreadCommand,
  DeleteSkillCommand,
  DeleteThreadCommand,
  FollowUpCommand,
  GetEntriesCommand,
  GetThreadCommand,
  ImportSkillCommand,
  PiSessionCommand,
  ProjectCommand,
  PromptCommand,
  RenameThreadCommand,
  ResponsePayload,
  SessionCommand,
  SetModelCommand,
  SetSessionNameCommand,
  SetThinkingLevelCommand,
  SkillCommand,
  SkillInfo,
  SteerCommand,
  ThinkingLevel,
  ThreadCommand,
  ThreadMode,
  UnarchiveThreadCommand,
} from "../src/index.ts";
import { WireServer, listenWs, wsUrlOf } from "../src/server-core.ts";
import type { WireServerApi } from "../src/server-core.ts";

/** The token the fixture accepts (clients use the same constant). */
export const TEST_TOKEN = "test-secret";
/** The single model the fixture's catalog knows. */
export const MOCK_MODEL = { contextWindow: 128_000, id: "m1", provider: "mock", reasoning: true };
/** Simulated run latency; prompts with this text are slow (timeout tests). */
const SLOW_MARKER = "slow";

// Aliased so the TaggedError class declaration below stays a plain call
// (`new` breaks the schema typecheck — `TaggedError` is a function returning
// a class, not a class).
const tagged = S.TaggedError;

/** The fixture's command failures (the core stringifies them into response errors). */
export class FixtureError extends tagged<FixtureError>()("FixtureError", {
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
  entries: { seq: number; type: string; id: string }[];
  nameSet: string | null;
}

/** The wire's `ThreadInfo` shape for one scripted thread. */
const threadInfo = (thread: ScriptedThread) => ({
  archivedAt: thread.archivedAt,
  cwd: thread.cwd,
  env: "ready",
  id: thread.id,
  mode: thread.mode,
  name: thread.name,
  sessionId: thread.sessionId,
  state: thread.state,
  tailSeq: thread.nextSeq - 1,
});

/** The close event's payload: the connection carries nothing on close. */
const CLOSE_PAYLOAD = undefined;

/** The session's optional name — present only once a console set one. */
const sessionName = (nameSet: string | null) => (nameSet === null ? {} : { name: nameSet });

export interface HubFixture {
  /** The ws:// URL the fixture's server listens on. */
  readonly url: string;
  /** The command tags the handlers have served, in order. */
  readonly calls: () => readonly string[];
  /** Close every client connection (simulates a server restart). */
  readonly dropAll: () => Effect.Effect<void>;
  /** Send a raw frame to every connected client (malformed-frame tests). */
  readonly sendRaw: (text: string) => Effect.Effect<void>;
  /** Close the server for good. */
  readonly close: () => Effect.Effect<void>;
}

/** Start the fixture: the real server core on an ephemeral loopback port. */
export const startHubFixture = Effect.fn("startHubFixture")(function* () {
  const threads = new Map<string, ScriptedThread>();
  const skills = new Map<string, SkillInfo>();
  const sockets = new Set<WebSocket>();
  const calls: string[] = [];

  const record = (tag: string) => Effect.sync(() => calls.push(tag));

  const threadChanged = (core: WireServerApi, thread: ScriptedThread) =>
    core.broadcast(ThreadChanged.make({ thread: threadInfo(thread) }));

  const findThread = (threadId: string) => {
    // Exact id first, then an unambiguous prefix (the real hub's contract).
    const exact = threads.get(threadId);
    if (exact !== undefined) {
      return exact;
    }
    const byPrefix = [...threads.values()].filter((t) => t.id.startsWith(threadId));
    return byPrefix.length === 1 ? byPrefix[0] : undefined;
  };

  const newThread = (input: {
    autoName?: boolean | undefined;
    cwd?: string | undefined;
    mode?: ThreadMode | undefined;
    name: string;
  }) => {
    const thread: ScriptedThread = {
      archivedAt: null,
      autoName: input.autoName === true,
      cwd: input.mode === "sandbox" ? null : (input.cwd ?? null),
      entries: [],
      id: randomUUID().replaceAll("-", ""),
      mode: input.mode ?? "local",
      name: input.name,
      nameSet: null,
      nextSeq: 1,
      sessionId: null,
      state: "idle",
      thinkingLevel: "off",
    };
    threads.set(thread.id, thread);
    return thread;
  };

  /** Settle one run: append the fake entry, broadcast it, go idle. */
  const settleRun = Effect.fn("settleRun")(function* (
    core: WireServerApi,
    thread: ScriptedThread,
    _text: string,
  ) {
    const entry = { id: `e${thread.nextSeq - 1}`, seq: thread.nextSeq, type: "user_message" };
    thread.nextSeq += 1;
    thread.entries.push(entry);
    thread.sessionId ??= thread.id;
    yield* core.broadcast(
      EventFrame.make({ event: { entry, type: "entry_appended" }, threadId: thread.id }),
    );
    thread.state = "idle";
    yield* threadChanged(core, thread);
    yield* core.broadcast(EventFrame.make({ event: { type: "settled" }, threadId: thread.id }));
  });

  const runHubCommand = (
    core: WireServerApi,
    hubCommand: ThreadCommand | SkillCommand | PiSessionCommand | ProjectCommand,
  ) =>
    Match.value(hubCommand).pipe(
      Match.withReturnType<Effect.Effect<ResponsePayload, FixtureError>>(),
      Match.tagsExhaustive({
        add_project: () =>
          Effect.fail(
            new FixtureError({
              kind: "projects_not_served",
              message: "projects are served by the local daemon, not the hub",
            }),
          ),
        archive_thread: Effect.fn("archive_thread")(function* (
          command: S.Schema.Type<typeof ArchiveThreadCommand>,
        ) {
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
          yield* threadChanged(core, thread);
          return ArchiveThreadResponse.make({ thread: threadInfo(thread) });
        }),
        browse_project_dirs: () =>
          Effect.fail(
            new FixtureError({
              kind: "projects_not_served",
              message: "projects are served by the local daemon, not the hub",
            }),
          ),
        create_thread: Effect.fn("create_thread")(function* (
          command: S.Schema.Type<typeof CreateThreadCommand>,
        ) {
          const thread = newThread(command);
          // Broadcast before responding — the hub's ordering: consoles
          // see the change before the command resolves.
          yield* threadChanged(core, thread);
          return CreateThreadResponse.make({ thread: threadInfo(thread) });
        }),
        delete_skill: Effect.fn("delete_skill")(function* (
          command: S.Schema.Type<typeof DeleteSkillCommand>,
        ) {
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
        delete_thread: Effect.fn("delete_thread")(function* (
          command: S.Schema.Type<typeof DeleteThreadCommand>,
        ) {
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
          yield* threadChanged(core, thread);
          return DeleteThreadResponse.make({});
        }),
        get_thread: Effect.fn("get_thread")(function* (
          command: S.Schema.Type<typeof GetThreadCommand>,
        ) {
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
        import_pi_session: () =>
          Effect.fail(
            new FixtureError({
              kind: "pi_sessions_not_served",
              message: "pi sessions are served by the local daemon, not the hub",
            }),
          ),
        // The fixture is the hub's shape: the project list scopes the local
        // daemon's pi-session window, so the hub rejects it too.
        import_skill: (command: S.Schema.Type<typeof ImportSkillCommand>) =>
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
        list_pi_sessions: () =>
          Effect.fail(
            new FixtureError({
              kind: "pi_sessions_not_served",
              message: "pi sessions are served by the local daemon, not the hub",
            }),
          ),
        list_projects: () =>
          Effect.fail(
            new FixtureError({
              kind: "projects_not_served",
              message: "projects are served by the local daemon, not the hub",
            }),
          ),
        list_skills: () =>
          Effect.succeed(ListSkillsResponse.make({ skills: [...skills.values()] })),
        list_threads: () =>
          Effect.succeed(
            ListThreadsResponse.make({ threads: [...threads.values()].map(threadInfo) }),
          ),
        remove_project: () =>
          Effect.fail(
            new FixtureError({
              kind: "projects_not_served",
              message: "projects are served by the local daemon, not the hub",
            }),
          ),
        rename_thread: Effect.fn("rename_thread")(function* (
          command: S.Schema.Type<typeof RenameThreadCommand>,
        ) {
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
          yield* threadChanged(core, thread);
          return RenameThreadResponse.make({ thread: threadInfo(thread) });
        }),
        unarchive_thread: Effect.fn("unarchive_thread")(function* (
          command: S.Schema.Type<typeof UnarchiveThreadCommand>,
        ) {
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
          yield* threadChanged(core, thread);
          return UnarchiveThreadResponse.make({ thread: threadInfo(thread) });
        }),
      }),
    );

  const runSessionCommand = Effect.fn("runSessionCommand")(function* (
    core: WireServerApi,
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
      Match.withReturnType<Effect.Effect<ResponsePayload, FixtureError>>(),
      Match.tagsExhaustive({
        abort: Effect.fn("abort")(function* () {
          if (thread.state === "working") {
            thread.state = "idle";
            yield* core.broadcast(
              EventFrame.make({ event: { type: "settled" }, threadId: thread.id }),
            );
          }
          return AbortResponse.make({});
        }),
        branch: Effect.fn("branch")(function* ({ entryId }: S.Schema.Type<typeof BranchCommand>) {
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
        compact: Effect.fn("compact")(function* () {
          if (thread.state === "working") {
            return yield* Effect.fail(
              new FixtureError({
                kind: "busy",
                message: "cannot compact while the agent is working",
              }),
            );
          }
          // Acked at acceptance (the real host's contract); the result is
          // the compaction_end event's business.
          return CompactResponse.make({});
        }),
        follow_up: Effect.fn("follow_up")(function* ({
          text,
        }: S.Schema.Type<typeof FollowUpCommand>) {
          if (thread.state === "working") {
            return FollowUpResponse.make({});
          }
          thread.state = "working";
          yield* threadChanged(core, thread);
          yield* Effect.forkDetach(settleRun(core, thread, text));
          return FollowUpResponse.make({});
        }),
        get_available_models: () =>
          Effect.succeed(GetAvailableModelsResponse.make({ models: [MOCK_MODEL] })),
        get_available_thinking_levels: () =>
          Effect.succeed(GetAvailableThinkingLevelsResponse.make({ levels: THINKING_LEVELS })),
        get_entries: ({ sinceSeq }: S.Schema.Type<typeof GetEntriesCommand>) =>
          Effect.succeed(
            GetEntriesResponse.make({
              entries: thread.entries.filter((e) => e.seq > (sinceSeq ?? 0)),
              leafId: thread.entries.at(-1)?.id ?? null,
              tailSeq: thread.nextSeq - 1,
            }),
          ),
        get_session_stats: () =>
          Effect.succeed(GetSessionStatsResponse.make({ stats: { totalPromptTokens: 0 } })),
        get_state: Effect.fn("get_state")(function* () {
          // A thread named after the slow marker delays its reads — the
          // client-timeout tests' vehicle now that run commands ack fast.
          if (thread.name.startsWith(SLOW_MARKER)) {
            yield* Effect.sleep("300 millis");
          }
          return GetStateResponse.make({
            state: {
              model: MOCK_MODEL,
              sessionId: thread.sessionId,
              state: thread.state,
              tailSeq: thread.nextSeq - 1,
              thinkingLevel: thread.thinkingLevel,
              ...sessionName(thread.nameSet),
            },
          });
        }),
        prompt: Effect.fn("prompt")(function* ({ text }: S.Schema.Type<typeof PromptCommand>) {
          if (thread.state === "working") {
            return yield* Effect.fail(
              new FixtureError({ kind: "busy", message: "agent is already processing" }),
            );
          }
          // Acked at acceptance: the run starts now, and the settle lands
          // after the response — the real host's contract.
          thread.state = "working";
          yield* threadChanged(core, thread);
          const settle =
            text.includes(SLOW_MARKER)
              ? Effect.sleep("300 millis").pipe(
                  Effect.flatMap(() => settleRun(core, thread, text)),
                )
              : settleRun(core, thread, text);
          yield* Effect.forkDetach(settle);
          return PromptResponse.make({});
        }),
        set_auto_compaction: () => Effect.succeed(SetAutoCompactionResponse.make({})),
        set_follow_up_mode: () => Effect.succeed(SetFollowUpModeResponse.make({})),
        set_model: Effect.fn("set_model")(function* ({
          modelId,
          provider,
        }: S.Schema.Type<typeof SetModelCommand>) {
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
        set_session_name: ({ name }: S.Schema.Type<typeof SetSessionNameCommand>) =>
          Effect.sync(() => {
            thread.nameSet = name;
            return SetSessionNameResponse.make({});
          }),
        set_steering_mode: () => Effect.succeed(SetSteeringModeResponse.make({})),
        set_thinking_level: ({ level }: S.Schema.Type<typeof SetThinkingLevelCommand>) =>
          Effect.sync(() => {
            thread.thinkingLevel = level;
            return SetThinkingLevelResponse.make({ level });
          }),
        steer: Effect.fn("steer")(function* ({ text }: S.Schema.Type<typeof SteerCommand>) {
          if (thread.state === "working") {
            return SteerResponse.make({});
          }
          thread.state = "working";
          yield* threadChanged(core, thread);
          yield* Effect.forkDetach(settleRun(core, thread, text));
          return SteerResponse.make({});
        }),
      }),
    );
  });

  const core: WireServerApi = yield* WireServer.make({
    handlers: {
      runHubCommand: (command) =>
        record(command._tag).pipe(Effect.flatMap(() => runHubCommand(core, command))),
      runSessionCommand: (threadId, command) =>
        record(command._tag).pipe(Effect.flatMap(() => runSessionCommand(core, threadId, command))),
    },
    token: () => Effect.succeed(TEST_TOKEN),
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
        if (socket.readyState === socket.OPEN) {
          socket.send(text);
        }
      }
    });

  const dropAll = () =>
    Effect.sync(() => {
      for (const socket of sockets) {
        socket.close();
      }
    });

  const close = Effect.fn("close")(function* () {
    yield* dropAll();
    yield* Effect.callback<undefined>((resume) => {
      server.close(() => {
        resume(Effect.succeed(CLOSE_PAYLOAD));
      });
      return Effect.void;
    });
  });

  return {
    calls: () => [...calls],
    close,
    dropAll,
    sendRaw,
    url: wsUrlOf(server),
  };
});
