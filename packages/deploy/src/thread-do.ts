/**
 * The thread DO (thread-do.ts): one Durable Object per thread (ADR 0001)
 * — the per-thread worker of the deployment. It hosts the real
 * `SessionHost` (pi-agent-core's `Agent` + `Session`) over DO storage
 * (the `KvStore` seam), drives the thread's env through `RemoteEnv`, and
 * reports everything the hub's registry needs back over the `/push`
 * channel.
 *
 * The DO is disposable: its session trail, record, and env handle live
 * in DO storage; a restart (or a crash) rebuilds the host from the trail
 * on the next command. Read-only commands never build a host (a session
 * starts on first mutation, ADR 0004). The idle-stop window is a DO
 * alarm armed by the hub's controller (`/arm-idle`, `/disarm-idle`); when
 * it fires, the hub pulls the trigger (`idleStopFired`).
 *
 * RPC surface (JSON over fetch):
 *
 * - `/create`          — the hub's record for this thread (persisted)
 * - `/delete`          — dispose the host, delete all storage
 * - `/command`         — one session command → `{payload, tailSeq}`
 * - `/set-env-handle`  — the persisted env handle (null clears it)
 * - `/arm-idle`        — `setAlarm(now + idleStopMs)`
 * - `/disarm-idle`     — `deleteAlarm()`
 */

import { Effect, Option } from "effect";
import { RemoteEnv, workerdSocketFactory } from "@saku/env/remote";
import type { EnvHandle } from "@saku/env/remote";
import {
  SessionHost,
  SessionHostError,
  RegistryError,
  runSessionCommand,
} from "@saku/worker/isolate";
import type { HostRegistryApi, ModelCatalogApi, ThreadRecord } from "@saku/worker/isolate";
import type { SessionCommand } from "@saku/wire";
import type { WorkerReport } from "@saku/hub/core";
import { KvStore } from "@saku/store";

import { varOrDefault } from "./env.ts";
import type { DeploymentEnv } from "./env.ts";
import { deploymentCatalog } from "./catalog.ts";
import {
  decodeCommandPayload,
  decodeCreatePayload,
  decodeSetEnvHandlePayload,
  jsonError,
  jsonOk,
  rpcErrorOf,
} from "./do-protocol.ts";
import { pushToHub } from "./rpc.ts";
import { IDLE_STOP_DEFAULT_MS } from "./hub-do.ts";

const RECORD_KEY = "record";
const THREAD_ID_KEY = "thread-id";
const ENV_HANDLE_KEY = "env-handle";

const toSessionHostError = (message: string) => (cause: unknown) =>
  new SessionHostError({
    cause,
    kind: "pi_seam",
    message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

/** The env key of a handle: the identity a rebuilt env connection is keyed on. */
const envKeyOf = (handle: EnvHandle | null) =>
  handle === null ? "none" : `${handle.url}|${handle.token}|${handle.relay?.envId ?? ""}`;

export class SakuThreadDO {
  private host: SessionHost | undefined;
  private record: ThreadRecord | undefined;
  private envHandle: EnvHandle | null | undefined;
  private envConnection: RemoteEnv | undefined;
  /** The handle the live env was built with (a changed handle rebuilds). */
  private envKey: string | undefined;
  private threadId: string | undefined;
  private readonly catalog: ModelCatalogApi;
  private readonly deployment: DeploymentEnv;
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState, deployment: DeploymentEnv) {
    this.state = state;
    this.deployment = deployment;
    this.catalog = deploymentCatalog(this.deployment);
  }

  private idleStopMs() {
    return Math.trunc(
      Number(varOrDefault(this.deployment, "SAKU_IDLE_STOP_MS", String(IDLE_STOP_DEFAULT_MS))),
    );
  }

  private async loadThreadId() {
    if (this.threadId !== undefined) {
      return this.threadId;
    }
    const stored = await this.state.storage.get<string>(THREAD_ID_KEY);
    this.threadId = stored ?? undefined;
    return this.threadId;
  }

  private async loadRecord() {
    if (this.record !== undefined) {
      return this.record;
    }
    const stored = await this.state.storage.get<ThreadRecord>(RECORD_KEY);
    this.record = stored ?? undefined;
    return this.record;
  }

  private async loadEnvHandle() {
    if (this.envHandle !== undefined) {
      return this.envHandle;
    }
    const stored = await this.state.storage.get<EnvHandle>(ENV_HANDLE_KEY);
    this.envHandle = stored ?? null;
    return this.envHandle;
  }

  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    try {
      if (path === "/create") {
        return await this.handleCreate(request);
      }
      if (path === "/delete") {
        return await this.handleDelete();
      }
      if (path === "/command") {
        return await this.handleCommand(request);
      }
      if (path === "/set-env-handle") {
        return await this.handleSetEnvHandle(request);
      }
      if (path === "/arm-idle") {
        await this.state.storage.setAlarm(Date.now() + this.idleStopMs());
        return jsonOk({});
      }
      if (path === "/disarm-idle") {
        await this.state.storage.deleteAlarm();
        return jsonOk({});
      }
      return jsonError("malformed", `unknown path: ${path}`);
    } catch (error) {
      // The tagged `CommandError` (SessionHostError | RegistryError) rejects
      // through the boundary; the envelope keeps its kind, so the hub never
      // matches on message text.
      const { kind, message } = rpcErrorOf(error);
      return jsonError(kind, message);
    }
  }

  /** The durable alarm: idle-stop fired — the hub pulls the trigger. */
  async alarm() {
    const threadId = await this.loadThreadId();
    if (threadId === undefined) {
      return;
    }
    pushToHub(this.deployment, { threadId, type: "idleStopFired" });
  }

  private async handleCreate(request: Request) {
    const body = await Effect.runPromise(
      Effect.tryPromise({
        catch: () => null,
        try: async () => await request.json(),
      }).pipe(Effect.flatMap((raw) => Effect.sync(() => decodeCreatePayload(raw)))),
    );
    if (Option.isNone(body)) {
      return jsonError("malformed", "malformed /create payload");
    }
    const { record } = body.value;
    await this.state.storage.put(RECORD_KEY, record);
    await this.state.storage.put(THREAD_ID_KEY, record.id);
    this.record = record;
    this.threadId = record.id;
    return jsonOk({});
  }

  private async handleDelete() {
    if (this.host !== undefined) {
      await Effect.runPromise(this.host.dispose().pipe(Effect.catch(() => Effect.void)));
      this.host = undefined;
    }
    this.record = undefined;
    this.threadId = undefined;
    this.envHandle = undefined;
    this.envConnection?.close();
    this.envConnection = undefined;
    await this.state.storage.deleteAlarm().catch(() => {
      /* the alarm may not be armed; deletion is best-effort */
    });
    await this.state.storage.deleteAll();
    return jsonOk({});
  }

  private async handleSetEnvHandle(request: Request) {
    const body = await Effect.runPromise(
      Effect.tryPromise({
        catch: () => null,
        try: async () => await request.json(),
      }).pipe(Effect.flatMap((raw) => Effect.sync(() => decodeSetEnvHandlePayload(raw)))),
    );
    if (Option.isNone(body)) {
      return jsonError("malformed", "malformed /set-env-handle payload");
    }
    const { handle } = body.value;
    await this.state.storage.put(ENV_HANDLE_KEY, handle);
    this.envHandle = handle;
    // A different endpoint (a resumed Box gets a new host URL) means the
    // old connection is dead: drop the env and rebuild the host from the
    // trail on the next command.
    const key = envKeyOf(handle);
    if (key !== this.envKey) {
      this.envConnection?.close();
      this.envConnection = undefined;
      this.envKey = undefined;
      if (this.host !== undefined) {
        await Effect.runPromise(this.host.dispose().pipe(Effect.catch(() => Effect.void)));
        this.host = undefined;
      }
    }
    return jsonOk({});
  }

  private async handleCommand(request: Request) {
    const body = await Effect.runPromise(
      Effect.tryPromise({
        catch: () => null,
        try: async () => await request.json(),
      }).pipe(Effect.flatMap((raw) => Effect.sync(() => decodeCommandPayload(raw)))),
    );
    if (Option.isNone(body)) {
      return jsonError("malformed", "malformed /command payload");
    }
    const { command } = body.value;
    const record = await this.loadRecord();
    if (record === undefined) {
      return jsonError("malformed", "unknown thread");
    }
    // The tagged `CommandError` (SessionHostError | RegistryError) rejects
    // through the boundary; the fetch catch above serializes its kind into
    // the envelope.
    const result = await Effect.runPromise(this.runCommand(record, command));
    return jsonOk({ payload: result.payload, tailSeq: result.tailSeq });
  }

  private runCommand(record: ThreadRecord, command: SessionCommand) {
    return Effect.fn("runCommand")({ self: this }, function* runCommand(this: SakuThreadDO) {
      // The shared dispatch serves the read-only commands without a host
      // (a thread whose session has never begun answers from the
      // record/catalog alone, ADR 0004) and starts the session on the
      // first mutating command.
      const payload = yield* runSessionCommand(
        {
          availableModels: () =>
            this.catalog
              .available()
              .pipe(Effect.map((models) => models.map((model) => this.catalog.toWireInfo(model)))),
          hostFor: () => this.hostFor(record),
          readOnlyHost: () => this.readOnlyHost(record),
        },
        record.id,
        command,
      );
      // Reads without a host report tailSeq 0; anything that touched a host
      // reports the live trail's tail.
      let tailSeq = 0;
      if (this.host !== undefined) {
        const { tailSeq: live } = yield* this.host
          .getEntries()
          .pipe(Effect.mapError(toSessionHostError("tailSeq")));
        tailSeq = live;
      }
      return { payload, tailSeq };
    })();
  }

  /** The live host only when the thread's session has already started; none otherwise. */
  private readOnlyHost(record: ThreadRecord) {
    return Effect.fn("readOnlyHost")({ self: this }, function* readOnlyHost(this: SakuThreadDO) {
      if (this.host !== undefined) {
        return Option.some(this.host);
      }
      // A session that has started (sessionId back-filled through the push
      // channel) rebuilds its host for reads; a never-started thread answers
      // from the record/catalog alone (ADR 0004).
      if (record.sessionId === null) {
        return Option.none();
      }
      return Option.some(yield* this.hostFor(record));
    })();
  }

  /** The lazy host: built on the first mutating command; crashed hosts rebuild. */
  private hostFor(record: ThreadRecord) {
    return Effect.fn("hostFor")({ self: this }, function* hostFor(this: SakuThreadDO) {
      const existing = this.host;
      if (existing !== undefined) {
        // A crashed host rebuilds from its trail on the next touch.
        if (existing.threadState !== "crashed") {
          return existing;
        }
        yield* existing.dispose().pipe(Effect.catch(() => Effect.void));
        this.host = undefined;
      }
      // The env: the persisted handle, connected before the host runs.
      const handle = yield* Effect.tryPromise({
        catch: toSessionHostError("load env handle"),
        try: async () => await this.loadEnvHandle(),
      });
      if (handle === null) {
        return yield* Effect.fail(
          new SessionHostError({
            kind: "no_env",
            message: "no env handle — the hub has not provisioned an env",
          }),
        );
      }
      const env = yield* Effect.try({
        catch: toSessionHostError("build env"),
        try: () => this.envFor(handle),
      });
      yield* Effect.tryPromise({
        catch: toSessionHostError("connect env"),
        try: async () => await env.connect(),
      });
      const registry = this.registry(record);
      const host = yield* SessionHost.create({
        catalog: this.catalog,
        env,
        record,
        registry,
        sink: (event) => {
          void Effect.runFork(
            Effect.fn("sink")({ self: this }, function* sink(this: SakuThreadDO) {
              const live = this.host;
              if (live !== undefined) {
                const { tailSeq } = yield* live
                  .getEntries()
                  .pipe(Effect.catch(() => Effect.succeed({ tailSeq: 0 })));
                pushToHub(this.deployment, {
                  event,
                  tailSeq,
                  threadId: record.id,
                  type: "sessionEvent",
                });
              }
            })(),
          );
        },
        threadId: record.id,
      }).pipe(
        // The thread's trail lives on this DO's storage (the platform
        // boundary, the `KvStore` service, doStorage backend).
        Effect.provide(KvStore.doStorage(this.state.storage)),
        Effect.mapError(toSessionHostError("create host")),
      );
      this.host = host;
      return host;
    })();
  }

  /** The live env connection for a handle; reconnects when needed. */
  private envFor(handle: EnvHandle) {
    const key = envKeyOf(handle);
    if (this.envConnection !== undefined && key === this.envKey) {
      return this.envConnection;
    }
    this.envConnection?.close();
    this.envConnection = new RemoteEnv(
      handle.relay === undefined
        ? { socket: workerdSocketFactory, token: handle.token, url: handle.url }
        : {
            relay: handle.relay,
            socket: workerdSocketFactory,
            token: handle.token,
            url: handle.url,
          },
    );
    this.envKey = key;
    return this.envConnection;
  }

  /**
   * The host's registry view: the narrow seam (get/update/setState) —
   * the record + state pushes reported to the hub (the hub owns the
   * durable registry; this is the push channel). The hub/daemon own
   * thread creation and deletion; the host only ever reads its own
   * record, back-fills its sessionId, and pushes liveness states.
   */
  private registry(record: ThreadRecord): HostRegistryApi {
    const push = (report: WorkerReport) => {
      pushToHub(this.deployment, { report, threadId: record.id, type: "report" });
    };
    const current = () => this.record ?? record;
    return {
      get: (threadId) =>
        Effect.succeed(threadId === record.id ? Option.some(current()) : Option.none()),
      setState: (threadId, state) =>
        Effect.sync(() => {
          push({ state });
        }),
      update: Effect.fn("update")(
        { self: this },
        function* update(
          this: SakuThreadDO,
          threadId: string,
          patch: Partial<Pick<ThreadRecord, "name" | "sessionId" | "nameAuto">>,
        ) {
          if (threadId !== record.id) {
            return Option.none();
          }
          const next: ThreadRecord = { ...current(), ...patch };
          this.record = next;
          yield* Effect.tryPromise({
            catch: (error) =>
              new RegistryError({
                cause: error,
                message: "persist thread record",
                op: "persist",
              }),
            try: async () => {
              await this.state.storage.put(RECORD_KEY, next);
            },
          });
          if (patch.sessionId !== undefined) {
            push({ sessionId: patch.sessionId });
          }
          if (patch.name !== undefined) {
            push({ name: patch.name });
          }
          return Option.some(next);
        },
      ),
    };
  }
}
