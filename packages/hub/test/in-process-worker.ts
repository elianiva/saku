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

import { Effect, FileSystem, Match, Option, Ref } from "effect";
import type { ExecutionEnv, StreamFn } from "@earendil-works/pi-agent-core";
import {
  getThreadTrailRoot,
  RegistryError,
  SessionHost,
  type ModelCatalogShape,
  type ThreadRecord,
  type ThreadRegistryShape,
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
  ResponsePayload,
  SetAutoCompactionResponse,
  SetFollowUpModeResponse,
  SetModelResponse,
  SetSessionNameResponse,
  SetSteeringModeResponse,
  SetThinkingLevelResponse,
  SteerResponse,
  THINKING_LEVELS,
  type SessionCommand,
} from "@saku/wire";

import { HubError } from "../src/index.ts";
import type {
  HubEventSink,
  HubRecord,
  ThreadWorkerRef,
  WorkerCommandResult,
  WorkerReport,
} from "../src/index.ts";

export interface InProcessWorkerOptions {
  readonly fs: FileSystem.FileSystem;
  readonly catalog: ModelCatalogShape;
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

const toHubError =
  (message: string) =>
  (error: unknown): HubError =>
    new HubError({ kind: "worker", message, cause: error });

/** The reads that never start a session (the hub's gate mirrors this). */
const READ_ONLY = new Set<SessionCommand["_tag"]>([
  "get_entries",
  "get_state",
  "get_available_models",
  "get_available_thinking_levels",
]);

/** The worker's no-session answers for the read-only commands. */
const readOnlyWithoutHost = (
  catalog: ModelCatalogShape,
  command: SessionCommand,
): Effect.Effect<WorkerCommandResult, HubError, never> =>
  Effect.gen(function* () {
    const payload: ResponsePayload =
      command._tag === "get_entries"
        ? GetEntriesResponse.make({ entries: [], tailSeq: 0, leafId: null })
        : command._tag === "get_state"
          ? GetStateResponse.make({
              state: {
                sessionId: null,
                state: "idle",
                tailSeq: 0,
                model: null,
                thinkingLevel: "off",
              },
            })
          : command._tag === "get_available_models"
            ? GetAvailableModelsResponse.make({
                models: (yield* catalog.available()).map((model) => catalog.toWireInfo(model)),
              })
            : GetAvailableThinkingLevelsResponse.make({ levels: [...THINKING_LEVELS] });
    return { payload, tailSeq: 0 };
  });

export const inProcessWorker = (
  options: InProcessWorkerOptions,
): Effect.Effect<InProcessWorkerRef, never, never> =>
  Effect.gen(function* () {
    const { fs, catalog } = options;
    const hostsRef = yield* Ref.make<ReadonlyMap<string, SessionHost>>(new Map());
    const recordsRef = yield* Ref.make<ReadonlyMap<string, ThreadRecord>>(new Map());
    let sink: HubEventSink | undefined;

    const report = (threadId: string, patch: WorkerReport): void => {
      sink?.report(threadId, patch);
    };

    /** The host's registry view: reports every visible change to the hub. */
    const registry: ThreadRegistryShape = {
      list: () => Ref.get(recordsRef).pipe(Effect.map((records) => [...records.values()])),
      get: (threadId) =>
        Ref.get(recordsRef).pipe(
          Effect.map((records) => Option.fromNullishOr(records.get(threadId))),
        ),
      create: () =>
        Effect.fail(
          new RegistryError({ message: "in-process worker: the hub owns thread creation" }),
        ),
      update: (threadId, patch) =>
        Effect.gen(function* () {
          const records = yield* Ref.get(recordsRef);
          const record = records.get(threadId);
          if (record === undefined) return Option.none();
          const next: ThreadRecord = { ...record, ...patch };
          yield* Ref.update(recordsRef, (records) => new Map(records).set(threadId, next));
          if (patch.sessionId !== undefined) report(threadId, { sessionId: patch.sessionId });
          if (patch.name !== undefined) report(threadId, { name: patch.name });
          return Option.some(next);
        }),
      setState: (threadId, state) =>
        Effect.sync(() => {
          report(threadId, { state });
        }),
      delete: () => Effect.succeed(false),
      toInfo: () => Effect.succeed(Option.none()),
    };

    /** The lazy host; created on the first mutating command. */
    const hostFor = (
      threadId: string,
      hubRecord: HubRecord,
    ): Effect.Effect<SessionHost, HubError, never> =>
      Effect.gen(function* () {
        const hosts = yield* Ref.get(hostsRef);
        const existing = hosts.get(threadId);
        if (existing !== undefined) {
          // A crashed host rebuilds from its trail on the next touch.
          if (existing.threadState !== "crashed") return existing;
          yield* existing.dispose();
          yield* Ref.update(hostsRef, (hosts) => {
            const next = new Map(hosts);
            next.delete(threadId);
            return next;
          });
        }
        const record: ThreadRecord = {
          id: hubRecord.id,
          name: hubRecord.name,
          cwd: hubRecord.cwd ?? process.cwd(),
          mode: hubRecord.mode,
          createdAt: hubRecord.createdAt,
          sessionId: hubRecord.sessionId,
          nameAuto: hubRecord.autoName,
        };
        yield* Ref.update(recordsRef, (records) => new Map(records).set(threadId, record));
        // The host's event sink rides the hub's channel, with the tailSeq the
        // host reports (the registry's tailSeq cache stays fresh).
        const hostRef = yield* Ref.make<Option.Option<SessionHost>>(Option.none());
        const host = yield* SessionHost.create({
          threadId,
          record,
          catalog,
          registry,
          sink: (event) => {
            void Effect.runFork(
              Effect.gen(function* () {
                const live = yield* Ref.get(hostRef);
                if (Option.isSome(live) && sink !== undefined) {
                  const { tailSeq } = yield* live.value.getEntries();
                  sink.sessionEvent(threadId, event, tailSeq);
                }
              }),
            );
          },
          env: options.env?.(record) ?? new LocalEnv(record.cwd, fs),
          ...(options.streamFn === undefined ? {} : { streamFn: options.streamFn }),
        }).pipe(
          // The in-process trail is file-backed under the thread's directory.
          Effect.provide(KvStore.file(fs, getThreadTrailRoot(threadId))),
          Effect.mapError(toHubError("create host")),
        );
        yield* Ref.set(hostRef, Option.some(host));
        yield* Ref.update(hostsRef, (hosts) => new Map(hosts).set(threadId, host));
        return host;
      });

    /** The tailSeq after a command (the hub's registry cache input). */
    const tailSeqOf = (host: SessionHost): Effect.Effect<number, HubError, never> =>
      host.getEntries().pipe(
        Effect.map(({ tailSeq }) => tailSeq),
        Effect.mapError(toHubError("tailSeq")),
      );

    /** Forward one command to the host and shape the wire response. */
    const runHostCommand = (
      host: SessionHost,
      command: SessionCommand,
    ): Effect.Effect<ResponsePayload, HubError, never> =>
      Effect.gen(function* () {
        return yield* Match.value(command).pipe(
          Match.withReturnType<Effect.Effect<ResponsePayload, HubError, never>>(),
          Match.tagsExhaustive({
            prompt: (command) =>
              host
                .prompt(command.text, command.images)
                .pipe(Effect.mapError(toHubError("prompt")), Effect.as(PromptResponse.make({}))),
            steer: (command) =>
              host
                .steer(command.text)
                .pipe(Effect.mapError(toHubError("steer")), Effect.as(SteerResponse.make({}))),
            follow_up: (command) =>
              host
                .followUp(command.text)
                .pipe(
                  Effect.mapError(toHubError("follow_up")),
                  Effect.as(FollowUpResponse.make({})),
                ),
            abort: () =>
              host
                .abort()
                .pipe(Effect.mapError(toHubError("abort")), Effect.as(AbortResponse.make({}))),
            set_steering_mode: (command) =>
              host.setSteeringMode(command.mode).pipe(Effect.as(SetSteeringModeResponse.make({}))),
            set_follow_up_mode: (command) =>
              host.setFollowUpMode(command.mode).pipe(Effect.as(SetFollowUpModeResponse.make({}))),
            compact: (command) =>
              host
                .compact(command.customInstructions)
                .pipe(
                  Effect.mapError(toHubError("compact")),
                  Effect.map((result) => CompactResponse.make({ result })),
                ),
            set_auto_compaction: (command) =>
              host
                .setAutoCompaction(command.enabled)
                .pipe(
                  Effect.mapError(toHubError("set_auto_compaction")),
                  Effect.as(SetAutoCompactionResponse.make({})),
                ),
            set_model: (command) =>
              host
                .setModel(command.provider, command.modelId)
                .pipe(
                  Effect.mapError(toHubError("set_model")),
                  Effect.map((model) => SetModelResponse.make({ model })),
                ),
            set_thinking_level: (command) =>
              host
                .setThinkingLevel(command.level)
                .pipe(
                  Effect.mapError(toHubError("set_thinking_level")),
                  Effect.map((level) => SetThinkingLevelResponse.make({ level })),
                ),
            set_session_name: (command) =>
              host
                .setSessionName(command.name)
                .pipe(
                  Effect.mapError(toHubError("set_session_name")),
                  Effect.as(SetSessionNameResponse.make({})),
                ),
            branch: (command) =>
              host
                .branch(command.entryId)
                .pipe(
                  Effect.mapError(toHubError("branch")),
                  Effect.map((leafId) => BranchResponse.make({ leafId })),
                ),
            get_session_stats: () =>
              host
                .getSessionStats()
                .pipe(
                  Effect.mapError(toHubError("get_session_stats")),
                  Effect.map((stats) => GetSessionStatsResponse.make({ stats })),
                ),
            get_entries: (command) =>
              host
                .getEntries(command.sinceSeq)
                .pipe(
                  Effect.mapError(toHubError("get_entries")),
                  Effect.map(({ entries, tailSeq, leafId }) =>
                    GetEntriesResponse.make({ entries, tailSeq, leafId }),
                  ),
                ),
            get_state: () =>
              host
                .getState()
                .pipe(
                  Effect.mapError(toHubError("get_state")),
                  Effect.map((state) => GetStateResponse.make({ state })),
                ),
            get_available_models: () =>
              catalog.available().pipe(
                Effect.map((models) =>
                  GetAvailableModelsResponse.make({
                    models: models.map((model) => catalog.toWireInfo(model)),
                  }),
                ),
              ),
            get_available_thinking_levels: () =>
              host.getAvailableThinkingLevels().pipe(
                Effect.map((levels) => GetAvailableThinkingLevelsResponse.make({ levels })),
              ),
          }),
        );
      });

    return {
      ref: {
        create: (threadId, record) =>
          Effect.gen(function* () {
            // The host is created lazily on first touch; the record is kept.
            yield* Ref.update(recordsRef, (records) =>
              new Map(records).set(threadId, {
                id: record.id,
                name: record.name,
                cwd: record.cwd ?? process.cwd(),
                mode: record.mode,
                createdAt: record.createdAt,
                sessionId: record.sessionId,
                nameAuto: record.autoName,
              }),
            );
          }),
        // The in-process host's env is pinned at construction (options.env);
        // the hub's handle is for the DO worker's remote env.
        setEnvHandle: () => Effect.void,
        delete: (threadId) =>
          Effect.gen(function* () {
            const hosts = yield* Ref.get(hostsRef);
            const host = hosts.get(threadId);
            if (host !== undefined) {
              yield* host.dispose();
              yield* Ref.update(hostsRef, (hosts) => {
                const next = new Map(hosts);
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
              .remove(getThreadTrailRoot(threadId), { recursive: true, force: true })
              .pipe(Effect.catch(() => Effect.void));
          }),
        command: (threadId, command) =>
          Effect.gen(function* () {
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
              id: record.id,
              name: record.name,
              cwd: record.cwd,
              mode: record.mode,
              autoName: record.nameAuto,
              createdAt: record.createdAt,
              sessionId: record.sessionId,
              env: "ready",
              envHandle: null,
            });
            const payload = yield* runHostCommand(host, command);
            return { payload, tailSeq: yield* tailSeqOf(host) };
          }),
        close: () =>
          Effect.gen(function* () {
            const hosts = yield* Ref.get(hostsRef);
            yield* Effect.forEach([...hosts.values()], (host) => host.dispose(), { discard: true });
            yield* Ref.set(hostsRef, new Map());
          }),
      },
      attach: (attached) => {
        sink = attached;
      },
    };
  });
