/**
 * InProcessWorker (in-process-worker.ts): a `ThreadWorkerRef` that wraps the
 * real `SessionHost` from `@saku/worker` — the production session machinery
 * (Agent + Session over a DO-style trail) driven through the hub's seam.
 *
 * This is the test twin of the thread-DO namespace binding (M4): it proves
 * the full stack — wire client ⇄ hub ⇄ SessionHost ⇄ DoSessionRepo over
 * `KvStore.file` — before the Durable Object adapter exists. The host is created
 * lazily on the first mutating command; read-only commands answer from
 * storage alone (a session is never started by browsing).
 *
 * Everything the host's registry writes (sessionId back-fill, auto-title,
 * state pushes) is reported to the hub through its `HubEventSink`, exactly
 * the channel the DO worker will use in production. The sink is attached
 * after the hub is built (the hub needs the ref first — chicken and egg,
 * resolved like the scripted worker's `attach`).
 */

import type { FileSystem } from "effect";
import { Effect, Match, Option, Ref } from "effect";
import type { ExecutionEnv, StreamFn } from "@earendil-works/pi-agent-core";
import { RegistryError, SessionHost } from "@saku/worker";
import type {
  ModelCatalogApi,
  PathsLayout,
  SessionHostOptions,
  ThreadRecord,
  ThreadRegistryApi,
} from "@saku/worker";
import { KvStore } from "@saku/store";
import { LocalEnv } from "@saku/env";
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
import type { ResponsePayload, SessionCommand } from "@saku/wire";

import { HubError } from "../src/index.ts";
import type { HubEventSink, HubRecord, ThreadWorkerRef, WorkerReport } from "../src/index.ts";

export interface InProcessWorkerOptions {
  readonly fs: FileSystem.FileSystem;
  readonly paths: PathsLayout;
  readonly catalog: ModelCatalogApi;
  /** Scripted agent stream (tests); defaults to the catalog's models. */
  readonly streamFn?: StreamFn;
  /** The thread's hands; defaults to a `LocalEnv` over the thread's cwd. */
  readonly env?: (record: ThreadRecord) => ExecutionEnv;
}

/** The worker ref with its hub-channel attachment point. */
export interface InProcessWorkerRef {
  readonly ref: ThreadWorkerRef;
  /** Attach the hub's push channel (the hub is built after the ref). */
  readonly attach: (sink: HubEventSink) => void;
}

const toHubError = (message: string) => (cause: unknown) =>
  new HubError({ cause, kind: "worker", message });

/** The reads that never start a session (the hub's gate mirrors this). */
const READ_ONLY = new Set<SessionCommand["_tag"]>([
  "get_entries",
  "get_state",
  "get_available_models",
  "get_available_thinking_levels",
]);

/** The worker's no-session answers for the read-only commands. */
const readOnlyWithoutHost = Effect.fn("readOnlyWithoutHost")(function* readOnlyWithoutHost(
  catalog: ModelCatalogApi,
  command: SessionCommand,
) {
  let payload: ResponsePayload;
  if (command._tag === "get_entries") {
    payload = GetEntriesResponse.make({ entries: [], leafId: null, tailSeq: 0 });
  } else if (command._tag === "get_state") {
    payload = GetStateResponse.make({
      state: {
        model: null,
        sessionId: null,
        state: "idle",
        tailSeq: 0,
        thinkingLevel: "off",
      },
    });
  } else if (command._tag === "get_available_models") {
    const models = yield* catalog.available();
    payload = GetAvailableModelsResponse.make({
      models: models.map((model) => catalog.toWireInfo(model)),
    });
  } else {
    payload = GetAvailableThinkingLevelsResponse.make({ levels: [...THINKING_LEVELS] });
  }
  return { payload, tailSeq: 0 };
});

export const inProcessWorker = Effect.fn("inProcessWorker")(function* inProcessWorker(
  options: InProcessWorkerOptions,
) {
  const { fs, paths, catalog } = options;
  const hostsRef = yield* Ref.make<ReadonlyMap<string, SessionHost>>(new Map());
  const recordsRef = yield* Ref.make<ReadonlyMap<string, ThreadRecord>>(new Map());
  let sink: HubEventSink | undefined;

  const report = (threadId: string, patch: WorkerReport) => {
    sink?.report(threadId, patch);
  };

  /** The host's registry view: reports every visible change to the hub. */
  const registry: ThreadRegistryApi = {
    create: () =>
      Effect.fail(
        new RegistryError({ message: "in-process worker: the hub owns thread creation" }),
      ),
    delete: () => Effect.succeed(false),
    get: (threadId) =>
      Ref.get(recordsRef).pipe(
        Effect.map((records) => Option.fromNullishOr(records.get(threadId))),
      ),
    list: () => Ref.get(recordsRef).pipe(Effect.map((records) => [...records.values()])),
    setState: (threadId, state) =>
      Effect.sync(() => {
        report(threadId, { state });
      }),
    toInfo: () => Effect.succeed(Option.none()),
    update: Effect.fn("update")(function* update(threadId, patch) {
      const records = yield* Ref.get(recordsRef);
      const record = records.get(threadId);
      if (record === undefined) {
        return Option.none();
      }
      const next: ThreadRecord = { ...record, ...patch };
      yield* Ref.update(recordsRef, (current) => new Map(current).set(threadId, next));
      if (patch.sessionId !== undefined) {
        report(threadId, { sessionId: patch.sessionId });
      }
      if (patch.name !== undefined) {
        report(threadId, { name: patch.name });
      }
      return Option.some(next);
    }),
  };

  /** The lazy host; created on the first mutating command. */
  const hostFor = Effect.fn("hostFor")(function* hostFor(threadId: string, hubRecord: HubRecord) {
    const hosts = yield* Ref.get(hostsRef);
    const existing = hosts.get(threadId);
    if (existing !== undefined) {
      // A crashed host rebuilds from its trail on the next touch.
      if (existing.threadState !== "crashed") {
        return existing;
      }
      yield* existing.dispose();
      yield* Ref.update(hostsRef, (current) => {
        const next = new Map(current);
        next.delete(threadId);
        return next;
      });
    }
    const record: ThreadRecord = {
      createdAt: hubRecord.createdAt,
      cwd: hubRecord.cwd ?? process.cwd(),
      id: hubRecord.id,
      mode: hubRecord.mode,
      name: hubRecord.name,
      nameAuto: hubRecord.autoName,
      sessionId: hubRecord.sessionId,
    };
    yield* Ref.update(recordsRef, (records) => new Map(records).set(threadId, record));
    // The host's event sink rides the hub's channel, with the tailSeq the
    // host reports (the registry's tailSeq cache stays fresh).
    const hostRef = yield* Ref.make<Option.Option<SessionHost>>(Option.none());
    const baseOptions: Omit<SessionHostOptions, "streamFn"> = {
      catalog,
      env: options.env?.(record) ?? new LocalEnv(record.cwd, fs),
      record,
      registry,
      sink: (event) => {
        void Effect.runFork(
          Effect.gen(function* pushEvent() {
            const live = yield* Ref.get(hostRef);
            if (Option.isSome(live) && sink !== undefined) {
              const { tailSeq } = yield* live.value.getEntries();
              sink.sessionEvent(threadId, event, tailSeq);
            }
          }),
        );
      },
      threadId,
    };
    const hostOptions: SessionHostOptions =
      options.streamFn === undefined ? baseOptions : { ...baseOptions, streamFn: options.streamFn };
    const host = yield* SessionHost.create(hostOptions).pipe(
      // The in-process trail is file-backed under the thread's directory.
      Effect.provide(KvStore.file(fs, paths.threadTrailRoot(threadId))),
      Effect.mapError(toHubError("create host")),
    );
    yield* Ref.set(hostRef, Option.some(host));
    yield* Ref.update(hostsRef, (current) => new Map(current).set(threadId, host));
    return host;
  });

  /** The tailSeq after a command (the hub's registry cache input). */
  const tailSeqOf = (host: SessionHost) =>
    host.getEntries().pipe(
      Effect.map(({ tailSeq }) => tailSeq),
      Effect.mapError(toHubError("tailSeq")),
    );

  /** Forward one command to the host and shape the wire response. */
  const runHostCommand = Effect.fn("runHostCommand")(function* runHostCommand(
    host: SessionHost,
    cmd: SessionCommand,
  ) {
    return yield* Match.value(cmd).pipe(
      Match.withReturnType<Effect.Effect<ResponsePayload, HubError>>(),
      Match.tagsExhaustive({
        abort: () =>
          host
            .abort()
            .pipe(Effect.mapError(toHubError("abort")), Effect.as(AbortResponse.make({}))),
        branch: (command) =>
          host.branch(command.entryId).pipe(
            Effect.mapError(toHubError("branch")),
            Effect.map((leafId) => BranchResponse.make({ leafId })),
          ),
        compact: (command) =>
          host.compact(command.customInstructions).pipe(
            Effect.mapError(toHubError("compact")),
            Effect.map((result) => CompactResponse.make({ result })),
          ),
        follow_up: (command) =>
          host
            .followUp(command.text)
            .pipe(Effect.mapError(toHubError("follow_up")), Effect.as(FollowUpResponse.make({}))),
        get_available_models: () =>
          catalog.available().pipe(
            Effect.map((models) =>
              GetAvailableModelsResponse.make({
                models: models.map((model) => catalog.toWireInfo(model)),
              }),
            ),
          ),
        get_available_thinking_levels: () =>
          host
            .getAvailableThinkingLevels()
            .pipe(Effect.map((levels) => GetAvailableThinkingLevelsResponse.make({ levels }))),
        get_entries: (command) =>
          host.getEntries(command.sinceSeq).pipe(
            Effect.mapError(toHubError("get_entries")),
            Effect.map(({ entries, tailSeq, leafId }) =>
              GetEntriesResponse.make({ entries, leafId, tailSeq }),
            ),
          ),
        get_session_stats: () =>
          host.getSessionStats().pipe(
            Effect.mapError(toHubError("get_session_stats")),
            Effect.map((stats) => GetSessionStatsResponse.make({ stats })),
          ),
        get_state: () =>
          host.getState().pipe(
            Effect.mapError(toHubError("get_state")),
            Effect.map((state) => GetStateResponse.make({ state })),
          ),
        prompt: (command) =>
          host
            .prompt(command.text, command.images)
            .pipe(Effect.mapError(toHubError("prompt")), Effect.as(PromptResponse.make({}))),
        set_auto_compaction: (command) =>
          host
            .setAutoCompaction(command.enabled)
            .pipe(
              Effect.mapError(toHubError("set_auto_compaction")),
              Effect.as(SetAutoCompactionResponse.make({})),
            ),
        set_follow_up_mode: (command) =>
          host.setFollowUpMode(command.mode).pipe(Effect.as(SetFollowUpModeResponse.make({}))),
        set_model: (command) =>
          host.setModel(command.provider, command.modelId).pipe(
            Effect.mapError(toHubError("set_model")),
            Effect.map((model) => SetModelResponse.make({ model })),
          ),
        set_session_name: (command) =>
          host
            .setSessionName(command.name)
            .pipe(
              Effect.mapError(toHubError("set_session_name")),
              Effect.as(SetSessionNameResponse.make({})),
            ),
        set_steering_mode: (command) =>
          host.setSteeringMode(command.mode).pipe(Effect.as(SetSteeringModeResponse.make({}))),
        set_thinking_level: (command) =>
          host.setThinkingLevel(command.level).pipe(
            Effect.mapError(toHubError("set_thinking_level")),
            Effect.map((level) => SetThinkingLevelResponse.make({ level })),
          ),
        steer: (command) =>
          host
            .steer(command.text)
            .pipe(Effect.mapError(toHubError("steer")), Effect.as(SteerResponse.make({}))),
      }),
    );
  });

  return {
    attach: (attached: HubEventSink) => {
      sink = attached;
    },
    ref: {
      close: Effect.fn("close")(function* close() {
        const hosts = yield* Ref.get(hostsRef);
        yield* Effect.forEach([...hosts.values()], (host) => host.dispose(), { discard: true });
        yield* Ref.set(hostsRef, new Map());
      }),
      command: Effect.fn("command")(function* runCommand(
        threadId: string,
        command: SessionCommand,
      ) {
        const hosts = yield* Ref.get(hostsRef);
        const existing = hosts.get(threadId);
        // A live, uncrashed host serves the command directly; a crashed
        // host falls through to hostFor, which rebuilds it from the trail.
        if (
          existing !== undefined &&
          existing.threadState !== "crashed" &&
          !READ_ONLY.has(command._tag)
        ) {
          const payload = yield* runHostCommand(existing, command);
          return { payload, tailSeq: yield* tailSeqOf(existing) };
        }
        // Read-only commands never start a session: a thread whose session
        // has never begun answers from the registry/catalog alone.
        if (existing === undefined && READ_ONLY.has(command._tag)) {
          return yield* readOnlyWithoutHost(catalog, command);
        }
        const record = yield* Ref.get(recordsRef).pipe(
          Effect.map((records) => records.get(threadId)),
        );
        if (record === undefined) {
          return yield* Effect.fail(
            new HubError({ kind: "registry", message: `unknown thread: ${threadId}` }),
          );
        }
        const host = yield* hostFor(threadId, {
          autoName: record.nameAuto,
          createdAt: record.createdAt,
          cwd: record.cwd,
          env: "ready",
          envHandle: null,
          id: record.id,
          mode: record.mode,
          name: record.name,
          sessionId: record.sessionId,
        });
        const payload = yield* runHostCommand(host, command);
        return { payload, tailSeq: yield* tailSeqOf(host) };
      }),
      create: Effect.fn("create")(function* create(threadId: string, record: HubRecord) {
        // The host is created lazily on first touch; the record is kept.
        yield* Ref.update(recordsRef, (records) =>
          new Map(records).set(threadId, {
            createdAt: record.createdAt,
            cwd: record.cwd ?? process.cwd(),
            id: record.id,
            mode: record.mode,
            name: record.name,
            nameAuto: record.autoName,
            sessionId: record.sessionId,
          }),
        );
      }),
      delete: Effect.fn("delete")(function* deleteThread(threadId: string) {
        const hosts = yield* Ref.get(hostsRef);
        const host = hosts.get(threadId);
        if (host !== undefined) {
          yield* host.dispose();
          yield* Ref.update(hostsRef, (current) => {
            const next = new Map(current);
            next.delete(threadId);
            return next;
          });
        }
        yield* Ref.update(recordsRef, (records) => {
          const next = new Map(records);
          next.delete(threadId);
          return next;
        });
        // The trail dies with the thread (the DO's deleteAll, in-process).
        yield* fs
          .remove(paths.threadTrailRoot(threadId), { force: true, recursive: true })
          .pipe(Effect.catch(() => Effect.void));
      }),
      // The in-process host's env is pinned at construction (options.env);
      // the hub's handle is for the DO worker's remote env.
      setEnvHandle: () => Effect.void,
    },
  };
});
