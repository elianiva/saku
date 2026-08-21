/**
 * The DO-to-DO RPC plumbing (rpc.ts): the hub DO and the thread DOs talk
 * plain JSON over their `fetch` endpoints (no alchemy runtime involved —
 * the same classes run under Cloudflare and celld).
 *
 * - the hub drives threads through `threadRpc` (create / delete /
 *   command / env-handle / idle-stop arm+disarm)
 * - the thread DOs push reports, session events, and idle-stop firings
 *   back through `hubRpc` (`/push` on the hub DO)
 */

import { Effect, Option, Schema } from "effect";
import type { EnvHandle } from "@saku/env/remote";
import { HubError } from "@saku/hub/core";
import type { HubRecord, ThreadWorkerRef } from "@saku/hub/core";
import type { ResponsePayload } from "@saku/wire";

import { HUB_INSTANCE } from "./env.ts";
import type { DeploymentEnv } from "./env.ts";
import type { CommandPayload, CreatePayload, HubPush, SetEnvHandlePayload } from "./do-protocol.ts";


/** A failed DO-to-DO call: the endpoint, the error kind, and the message. */
export class RpcError extends Schema.TaggedError<RpcError>()("RpcError", {
  cause: Schema.optional(Schema.Unknown),
  /** The failure's discriminator (a SessionHostError kind, a HubError kind, or "malformed"). */
  kind: Schema.String,
  message: Schema.String,
  path: Schema.String,
  status: Schema.optional(Schema.Number),
}) {}

const toHubError = (context: string) => (cause: unknown) =>
  new HubError({
    cause,
    kind: "worker",
    message: `${context}: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

/** The JSON body of a thread-DO call: one endpoint payload (or the empty `{}`). */
type ThreadRpcBody = CommandPayload | CreatePayload | SetEnvHandlePayload | Record<string, never>;

/**
 * A schema that accepts any payload and types it as `T` — the ADR 0005
 * seam: opaque JSON crossed unvalidated, never re-schemed.
 */
const opaque = <T>() =>
  Schema.declare<T>((_u): _u is T => true, {
    description: "opaque payload, carried unvalidated (ADR 0005)",
  });

/** The DO's JSON response envelope (the shape `do-protocol`'s `RpcEnvelope` documents). */
const RpcEnvelopeSchema = Schema.Struct({
  error: Schema.optional(Schema.Struct({ kind: Schema.String, message: Schema.String })),
  ok: Schema.Boolean,
  payload: Schema.optional(Schema.Unknown),
});

/** The /command envelope's payload: the worker's `{ payload, tailSeq }` result. */
const CommandResultPayload = Schema.Struct({
  payload: opaque<ResponsePayload>(),
  tailSeq: Schema.Number,
});

/** Parse and validate one DO's JSON response into the envelope, or surface the RPC error. */
const parseEnvelope = (response: Response, path: string, failure: string) =>
  Effect.gen(function* () {
    const json = yield* Effect.tryPromise({
      catch: () =>
        new RpcError({
          kind: "malformed",
          message: `${failure} (${response.status})`,
          path,
          status: response.status,
        }),
      try: () => response.json(),
    });
    const parsed = Schema.decodeUnknownOption(RpcEnvelopeSchema)(json);
    if (Option.isNone(parsed)) {
      return yield* Effect.fail(
        new RpcError({
          kind: "malformed",
          message: `${failure} (${response.status})`,
          path,
          status: response.status,
        }),
      );
    }
    const envelope = parsed.value;
    if (!response.ok || !envelope.ok) {
      const error = envelope.ok ? undefined : envelope.error;
      return yield* Effect.fail(
        new RpcError({
          kind: error?.kind ?? "malformed",
          message: error?.message ?? `${failure} (${response.status})`,
          path,
          status: response.status,
        }),
      );
    }
    return envelope;
  });

/** Fetch from a DO stub, surfacing network errors as RpcError. */
const fetchDo = (
  stub: { fetch: (url: string, init?: RequestInit) => Promise<Response> },
  url: string,
  body: string,
  path: string,
) =>
  Effect.tryPromise({
    catch: (error) =>
      new RpcError({
        kind: "unknown",
        message: String(error),
        path,
      }),
    try: () =>
      stub.fetch(url, {
        body,
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
  });

/** Call one endpoint on the hub DO. */
export const hubRpc = (env: DeploymentEnv, path: string, body: HubPush) =>
  Effect.gen(function* () {
    const stub = env.HUB.get(env.HUB.idFromName(HUB_INSTANCE));
    const response = yield* fetchDo(
      stub,
      `https://hub.internal${path}`,
      JSON.stringify(body),
      path,
    );
    return yield* parseEnvelope(response, path, `hub rpc ${path} failed`);
  });

/** Call one endpoint on a thread DO (the instance named by threadId). */
export const threadRpc = (
  env: DeploymentEnv,
  threadId: string,
  path: string,
  body: ThreadRpcBody,
) =>
  Effect.gen(function* () {
    const stub = env.THREAD.get(env.THREAD.idFromName(threadId));
    const response = yield* fetchDo(
      stub,
      `https://thread.internal${path}`,
      JSON.stringify(body),
      path,
    );
    return yield* parseEnvelope(response, path, `thread rpc ${path} failed`);
  });

/**
 * The worker's record for the `/create` RPC: the hub's registry record
 * projected onto the worker's `ThreadRecord` contract (the thread DO
 * decodes `/create` against `ThreadRecordSchema`). The hub's cwd is null
 * for sandbox threads; the worker's is a path.
 */
const workerRecordOf = (record: HubRecord) => ({
  createdAt: record.createdAt,
  cwd: record.cwd ?? "/",
  id: record.id,
  mode: record.mode,
  name: record.name,
  nameAuto: record.autoName,
  sessionId: record.sessionId,
});

/** The hub's `ThreadWorkerRef` over the thread-DO namespace. */
export const threadWorkerRef = (env: DeploymentEnv): ThreadWorkerRef => ({
  close: () => Effect.void,
  command: (threadId, command) =>
    Effect.gen(function* () {
      const envelope = yield* threadRpc(env, threadId, "/command", { command });
      const payload = Schema.decodeUnknownOption(CommandResultPayload)(envelope.payload);
      if (Option.isNone(payload)) {
        return yield* Effect.fail(
          new RpcError({
            kind: "malformed",
            message: "thread rpc /command returned a malformed payload",
            path: "/command",
          }),
        );
      }
      return payload.value;
    }).pipe(Effect.catch((e) => Effect.fail(toHubError("thread command")(e)))),
  create: (threadId, record) =>
    threadRpc(env, threadId, "/create", { record: workerRecordOf(record) }).pipe(
      Effect.andThen(Effect.void),
      Effect.catch((e) => Effect.fail(toHubError("create thread worker")(e))),
    ),
  delete: (threadId) =>
    threadRpc(env, threadId, "/delete", {}).pipe(
      Effect.andThen(Effect.void),
      Effect.catch((e) => Effect.fail(toHubError("delete thread worker")(e))),
    ),
  setEnvHandle: (threadId, handle) =>
    threadRpc(env, threadId, "/set-env-handle", { handle }).pipe(
      Effect.andThen(Effect.void),
      Effect.catch((e) => Effect.fail(toHubError("set env handle")(e))),
    ),
});

/** Set (or clear) a thread's env handle from the hub. */
export const setThreadEnvHandle = (
  env: DeploymentEnv,
  threadId: string,
  handle: EnvHandle | null,
) =>
  threadRpc(env, threadId, "/set-env-handle", { handle }).pipe(
    Effect.andThen(Effect.void),
    Effect.catch((e) => Effect.fail(toHubError("set env handle")(e))),
  );

/** The idle-stop controller: arm/disarm the thread DO's durable alarm. */
export const threadIdleStop = (env: DeploymentEnv) => ({
  arm: (threadId: string) =>
    threadRpc(env, threadId, "/arm-idle", {}).pipe(
      Effect.andThen(Effect.void),
      Effect.catch((e) => Effect.fail(toHubError("arm idle-stop")(e))),
    ),
  disarm: (threadId: string) =>
    threadRpc(env, threadId, "/disarm-idle", {}).pipe(
      Effect.catch((e) => Effect.fail(toHubError("disarm idle-stop")(e))),
      Effect.result,
      Effect.asVoid,
    ),
});

/** Push a report/event to the hub (best-effort; advisory content). */
export const pushToHub = (env: DeploymentEnv, push: HubPush) => {
  void Effect.runPromise(
    hubRpc(env, "/push", push).pipe(
      Effect.catch((error) => Effect.logError(`[thread-do] hub push failed: ${String(error)}`)),
    ),
  );
};

/**
 * Push and wait for the hub's ack. Reports and session events are advisory
 * (a lost one costs a console a catch-up read); the idle-stop firing is not
 * — it is the only message that suspends the remote machine, and its alarm
 * has already been consumed when it sends. Callers re-arm on `false`.
 */
export const pushToHubAcked = (env: DeploymentEnv, push: HubPush) =>
  hubRpc(env, "/push", push).pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  );
