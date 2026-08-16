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

/** Tagged errors in this file are declared through this alias (Schema.TaggedError). */
const taggedError = Schema.TaggedError;

/** A failed DO-to-DO call: the endpoint, the error kind, and the message. */
export class RpcError extends taggedError<RpcError>()("RpcError", {
  cause: Schema.optional(Schema.Unknown),
  /** The failure's discriminator (a SessionHostError kind, a RegistryError op, "malformed"). */
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

/** Parse and validate one DO's JSON response into the envelope, or throw the RPC error. */
const parseEnvelope = async (response: Response, path: string, failure: string) => {
  const parsed = Schema.decodeUnknownOption(RpcEnvelopeSchema)(await response.json());
  if (Option.isNone(parsed)) {
    throw new RpcError({
      kind: "malformed",
      message: `${failure} (${response.status})`,
      path,
      status: response.status,
    });
  }
  const envelope = parsed.value;
  if (!response.ok || !envelope.ok) {
    const error = envelope.ok ? undefined : envelope.error;
    throw new RpcError({
      kind: error?.kind ?? "malformed",
      message: error?.message ?? `${failure} (${response.status})`,
      path,
      status: response.status,
    });
  }
  return envelope;
};

/** Call one endpoint on the hub DO. */
export const hubRpc = async (env: DeploymentEnv, path: string, body: HubPush) => {
  const stub = env.HUB.get(env.HUB.idFromName(HUB_INSTANCE));
  const response = await stub.fetch(`https://hub.internal${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  return await parseEnvelope(response, path, `hub rpc ${path} failed`);
};

/** Call one endpoint on a thread DO (the instance named by threadId). */
export const threadRpc = async (
  env: DeploymentEnv,
  threadId: string,
  path: string,
  body: ThreadRpcBody,
) => {
  const stub = env.THREAD.get(env.THREAD.idFromName(threadId));
  const response = await stub.fetch(`https://thread.internal${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  return await parseEnvelope(response, path, `thread rpc ${path} failed`);
};

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
    Effect.tryPromise({
      catch: toHubError("thread command"),
      try: async () => {
        const envelope = await threadRpc(env, threadId, "/command", { command });
        const payload = Schema.decodeUnknownOption(CommandResultPayload)(envelope.payload);
        if (Option.isNone(payload)) {
          throw new RpcError({
            kind: "malformed",
            message: "thread rpc /command returned a malformed payload",
            path: "/command",
          });
        }
        return payload.value;
      },
    }),
  create: (threadId, record) =>
    Effect.tryPromise({
      catch: toHubError("create thread worker"),
      try: async () =>
        await threadRpc(env, threadId, "/create", { record: workerRecordOf(record) }),
    }).pipe(Effect.andThen(Effect.void)),
  delete: (threadId) =>
    Effect.tryPromise({
      catch: toHubError("delete thread worker"),
      try: async () => await threadRpc(env, threadId, "/delete", {}),
    }).pipe(Effect.andThen(Effect.void)),
  setEnvHandle: (threadId, handle) =>
    Effect.tryPromise({
      catch: toHubError("set env handle"),
      try: async () => await threadRpc(env, threadId, "/set-env-handle", { handle }),
    }).pipe(Effect.andThen(Effect.void)),
});

/** Set (or clear) a thread's env handle from the hub. */
export const setThreadEnvHandle = (
  env: DeploymentEnv,
  threadId: string,
  handle: EnvHandle | null,
) =>
  Effect.tryPromise({
    catch: toHubError("set env handle"),
    try: async () => await threadRpc(env, threadId, "/set-env-handle", { handle }),
  }).pipe(Effect.andThen(Effect.void));

/** The idle-stop controller: arm/disarm the thread DO's durable alarm. */
export const threadIdleStop = (env: DeploymentEnv) => ({
  arm: (threadId: string) =>
    Effect.tryPromise({
      catch: toHubError("arm idle-stop"),
      try: async () => await threadRpc(env, threadId, "/arm-idle", {}),
    }).pipe(Effect.andThen(Effect.void)),
  disarm: (threadId: string) =>
    Effect.tryPromise({
      catch: toHubError("disarm idle-stop"),
      try: async () => await threadRpc(env, threadId, "/disarm-idle", {}),
    }).pipe(Effect.result, Effect.asVoid),
});

/** Push a report/event/idle-stop firing to the hub (best-effort). */
export const pushToHub = (env: DeploymentEnv, push: HubPush) => {
  void (async () => {
    try {
      await hubRpc(env, "/push", push);
    } catch (error) {
      // The push is a plain promise boundary: fork the log.
      void Effect.runFork(Effect.logError(`[thread-do] hub push failed: ${String(error)}`));
    }
  })();
};
