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
import type { ExecutionEnv, StreamFn } from "@earendil-works/pi-agent-core";
import { RemoteEnv, workerdSocketFactory, type EnvHandle } from "@saku/env/remote";
import {
  SessionHost,
  SessionHostError,
  RegistryError,
  runSessionCommand,
  type ModelCatalogShape,
  type ThreadRecord,
  type ThreadRegistryShape,
} from "@saku/worker/isolate";
import { type ResponsePayload, type SessionCommand } from "@saku/wire";
import type { HubEventSink, WorkerReport } from "@saku/hub/core";
import { KvStore } from "@saku/store";

import { varOrDefault, type DeploymentEnv } from "./env.ts";
import { deploymentCatalog } from "./catalog.ts";
import { pushToHub } from "./rpc.ts";
import { IDLE_STOP_DEFAULT_MS } from "./hub-do.ts";

const RECORD_KEY = "record";
const THREAD_ID_KEY = "thread-id";
const ENV_HANDLE_KEY = "env-handle";

const toSessionHostError =
  (message: string) =>
  (error: unknown): SessionHostError =>
    new SessionHostError({
      message: `${message}: ${error instanceof Error ? error.message : String(error)}`,
      cause: error,
    });

/** The failures a session command can produce (stringified at the fetch boundary). */
type CommandError = SessionHostError | RegistryError;

export class SakuThreadDO {
  private host: SessionHost | undefined;
  private record: ThreadRecord | undefined;
  private envHandle: EnvHandle | null | undefined;
  private envConnection: RemoteEnv | undefined;
  /** The handle the live env was built with (a changed handle rebuilds). */
  private envKey: string | undefined;
  private threadId: string | undefined;
  private readonly catalog: ModelCatalogShape;

  constructor(
    private readonly state: DurableObjectState,
    private readonly deployment: DeploymentEnv,
  ) {
    this.catalog = deploymentCatalog(this.deployment);
  }

  private idleStopMs(): number {
    return Number.parseInt(
      varOrDefault(this.deployment, "SAKU_IDLE_STOP_MS", String(IDLE_STOP_DEFAULT_MS)),
      10,
    );
  }

  private async loadThreadId(): Promise<string | undefined> {
    if (this.threadId !== undefined) return this.threadId;
    const stored = await this.state.storage.get<string>(THREAD_ID_KEY);
    this.threadId = stored ?? undefined;
    return this.threadId;
  }

  private async loadRecord(): Promise<ThreadRecord | undefined> {
    if (this.record !== undefined) return this.record;
    const stored = await this.state.storage.get<ThreadRecord>(RECORD_KEY);
    this.record = stored ?? undefined;
    return this.record;
  }

  private async loadEnvHandle(): Promise<EnvHandle | null> {
    if (this.envHandle !== undefined) return this.envHandle;
    const stored = await this.state.storage.get<EnvHandle>(ENV_HANDLE_KEY);
    this.envHandle = stored ?? null;
    return this.envHandle;
  }

  // -- fetch routing --------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      switch (path) {
        case "/create":
          return await this.handleCreate(request);
        case "/delete":
          return await this.handleDelete();
        case "/command":
          return await this.handleCommand(request);
        case "/set-env-handle":
          return await this.handleSetEnvHandle(request);
        case "/arm-idle":
          await this.state.storage.setAlarm(Date.now() + this.idleStopMs());
          return jsonOk({});
        case "/disarm-idle":
          await this.state.storage.deleteAlarm();
          return jsonOk({});
        default:
          return jsonError(`unknown path: ${path}`);
      }
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : String(error));
    }
  }

  /** The durable alarm: idle-stop fired — the hub pulls the trigger. */
  async alarm(): Promise<void> {
    const threadId = await this.loadThreadId();
    if (threadId === undefined) return;
    pushToHub(this.deployment, { type: "idleStopFired", threadId });
  }

  // -- handlers -------------------------------------------------------------

  private async handleCreate(request: Request): Promise<Response> {
    const body = (await request.json()) as { record?: ThreadRecord };
    const record = body.record;
    if (record === undefined) return jsonError("missing record");
    await this.state.storage.put(RECORD_KEY, record);
    await this.state.storage.put(THREAD_ID_KEY, record.id);
    this.record = record;
    this.threadId = record.id;
    return jsonOk({});
  }

  private async handleDelete(): Promise<Response> {
    if (this.host !== undefined) {
      await Effect.runPromise(this.host.dispose().pipe(Effect.catch(() => Effect.void)));
      this.host = undefined;
    }
    this.record = undefined;
    this.threadId = undefined;
    this.envHandle = undefined;
    this.envConnection?.close();
    this.envConnection = undefined;
    await this.state.storage.deleteAlarm().catch(() => undefined);
    await this.state.storage.deleteAll();
    return jsonOk({});
  }

  private async handleSetEnvHandle(request: Request): Promise<Response> {
    const body = (await request.json()) as { handle?: EnvHandle | null };
    const handle = body.handle ?? null;
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

  private async handleCommand(request: Request): Promise<Response> {
    const body = (await request.json()) as { command?: SessionCommand };
    const command = body.command;
    if (command === undefined) return jsonError("missing command");
    const record = await this.loadRecord();
    if (record === undefined) return jsonError("unknown thread");
    const result = await Effect.runPromise(
      this.runCommand(record, command).pipe(
        Effect.catch((error: unknown) =>
          Effect.fail(new Error(error instanceof Error ? error.message : String(error))),
        ),
      ),
    );
    return jsonOk({ payload: result.payload, tailSeq: result.tailSeq });
  }

  private runCommand(
    record: ThreadRecord,
    command: SessionCommand,
  ): Effect.Effect<{ payload: ResponsePayload; tailSeq: number }, CommandError, never> {
    const self = this;
    return Effect.gen(function* () {
      // The shared dispatch serves the read-only commands without a host
      // (a thread whose session has never begun answers from the
      // record/catalog alone, ADR 0004) and starts the session on the
      // first mutating command.
      const payload = yield* runSessionCommand(
        {
          hostFor: () => self.hostFor(record),
          readOnlyHost: () => self.readOnlyHost(record),
          availableModels: () =>
            self.catalog
              .available()
              .pipe(Effect.map((models) => models.map((model) => self.catalog.toWireInfo(model)))),
        },
        record.id,
        command,
      );
      // Reads without a host report tailSeq 0; anything that touched a host
      // reports the live trail's tail.
      let tailSeq = 0;
      if (self.host !== undefined) {
        const { tailSeq: live } = yield* self.host
          .getEntries()
          .pipe(Effect.mapError(toSessionHostError("tailSeq")));
        tailSeq = live;
      }
      return { payload, tailSeq };
    });
  }

  /** The live host only when the thread's session has already started; none otherwise. */
  private readOnlyHost(
    record: ThreadRecord,
  ): Effect.Effect<Option.Option<SessionHost>, CommandError, never> {
    const self = this;
    return Effect.gen(function* () {
      if (self.host !== undefined) return Option.some(self.host);
      // A session that has started (sessionId back-filled through the push
      // channel) rebuilds its host for reads; a never-started thread answers
      // from the record/catalog alone (ADR 0004).
      if (record.sessionId === null) return Option.none();
      return Option.some(yield* self.hostFor(record));
    });
  }

  /** The lazy host: built on the first mutating command; crashed hosts rebuild. */
  private hostFor(record: ThreadRecord): Effect.Effect<SessionHost, CommandError, never> {
    const self = this;
    return Effect.gen(function* () {
      const existing = self.host;
      if (existing !== undefined) {
        // A crashed host rebuilds from its trail on the next touch.
        if (existing.threadState !== "crashed") return existing;
        yield* existing.dispose().pipe(Effect.catch(() => Effect.void));
        self.host = undefined;
      }
      // The env: the persisted handle, connected before the host runs.
      const handle = yield* Effect.tryPromise({
        try: () => self.loadEnvHandle(),
        catch: toSessionHostError("load env handle"),
      });
      if (handle === null) {
        return yield* Effect.fail(
          new SessionHostError({ message: "no env handle — the hub has not provisioned an env" }),
        );
      }
      const env = yield* Effect.promise(() => self.envFor(handle));
      yield* Effect.promise(() => env.connect());
      const registry = self.registryShape(record);
      const host = yield* SessionHost.create({
        threadId: record.id,
        record,
        catalog: self.catalog,
        registry,
        env,
        sink: (event) => {
          void Effect.runFork(
            Effect.gen(function* () {
              const live = self.host;
              if (live !== undefined) {
                const { tailSeq } = yield* live
                  .getEntries()
                  .pipe(Effect.catch(() => Effect.succeed({ tailSeq: 0 })));
                pushToHub(self.deployment, {
                  type: "sessionEvent",
                  threadId: record.id,
                  event,
                  tailSeq,
                });
              }
            }),
          );
        },
      }).pipe(
        // The thread's trail lives on this DO's storage (the platform
        // boundary, the `KvStore` service, doStorage backend).
        Effect.provide(KvStore.doStorage(self.state.storage)),
        Effect.mapError(toSessionHostError("create host")),
      );
      self.host = host;
      return host;
    });
  }

  /** The live env connection for a handle; reconnects when needed. */
  private async envFor(handle: EnvHandle): Promise<RemoteEnv> {
    const key = envKeyOf(handle);
    if (this.envConnection !== undefined && key === this.envKey) return this.envConnection;
    this.envConnection?.close();
    this.envConnection = new RemoteEnv({
      url: handle.url,
      token: handle.token,
      socket: workerdSocketFactory,
      ...(handle.relay === undefined ? {} : { relay: handle.relay }),
    });
    this.envKey = key;
    return this.envConnection;
  }

  /**
   * The host's registry view: the record + state pushes reported to the
   * hub (the hub owns the durable registry; this is the push channel).
   */
  private registryShape(record: ThreadRecord): ThreadRegistryShape {
    const self = this;
    const push = (report: WorkerReport): void => {
      pushToHub(self.deployment, { type: "report", threadId: record.id, report });
    };
    const current = (): ThreadRecord => self.record ?? record;
    return {
      list: () => Effect.succeed([current()]),
      get: (threadId) =>
        Effect.succeed(threadId === record.id ? Option.some(current()) : Option.none()),
      create: () =>
        Effect.fail(new RegistryError({ message: "thread DO: the hub owns thread creation" })),
      update: (threadId, patch) =>
        Effect.gen(function* () {
          if (threadId !== record.id) return Option.none();
          const next: ThreadRecord = { ...current(), ...patch };
          self.record = next;
          yield* Effect.promise(() => self.state.storage.put(RECORD_KEY, next));
          if (patch.sessionId !== undefined) push({ sessionId: patch.sessionId });
          if (patch.name !== undefined) push({ name: patch.name });
          return Option.some(next);
        }),
      setState: (threadId, state) =>
        Effect.sync(() => {
          push({ state });
        }),
      delete: () => Effect.succeed(false),
      toInfo: () => Effect.succeed(Option.none()),
    };
  }
}

const envKeyOf = (handle: EnvHandle | null): string =>
  handle === null ? "none" : `${handle.url}|${handle.token}|${handle.relay?.envId ?? ""}`;

const jsonOk = (payload: unknown): Response => Response.json({ ok: true, payload });

const jsonError = (error: string): Response => Response.json({ ok: false, error }, { status: 400 });
