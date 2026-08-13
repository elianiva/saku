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

import { Effect, Schema } from "effect";
import type { EnvHandle } from "@saku/env/remote";
import {
  HubError,
  type HubRecord,
  type ThreadWorkerRef,
  type WorkerCommandResult,
  type WorkerReport,
} from "@saku/hub/core";
import type { ThreadRecord } from "@saku/worker/isolate";

import { HUB_INSTANCE, type DeploymentEnv } from "./env.ts";
import type { HubPush, RpcEnvelope } from "./do-protocol.ts";

/** A failed DO-to-DO call: the endpoint, the error kind, and the message. */
export class RpcError extends Schema.TaggedError<RpcError>()("RpcError", {
  path: Schema.String,
  /** The failure's discriminator (a SessionHostError kind, a RegistryError op, "malformed"). */
  kind: Schema.String,
  message: Schema.String,
  status: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Unknown),
}) {}

const toHubError =
  (context: string) =>
  (error: unknown): HubError =>
    new HubError({
      kind: "worker",
      message: `${context}: ${error instanceof Error ? error.message : String(error)}`,
      cause: error,
    });

/** Call one endpoint on the hub DO. */
export const hubRpc = (env: DeploymentEnv, path: string, body: unknown): Promise<RpcEnvelope> => {
  const stub = env.HUB.get(env.HUB.idFromName(HUB_INSTANCE));
  return stub
    .fetch(`https://hub.internal${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    .then(async (response) => {
      const parsed = (await response.json()) as RpcEnvelope;
      if (!response.ok || !parsed.ok) {
        const error = parsed.ok ? undefined : parsed.error;
        throw new RpcError({
          path,
          kind: error?.kind ?? "malformed",
          message: error?.message ?? `hub rpc ${path} failed (${response.status})`,
          status: response.status,
        });
      }
      return parsed;
    });
};

/** Call one endpoint on a thread DO (the instance named by threadId). */
export const threadRpc = (
  env: DeploymentEnv,
  threadId: string,
  path: string,
  body: unknown,
): Promise<RpcEnvelope> => {
  const stub = env.THREAD.get(env.THREAD.idFromName(threadId));
  return stub
    .fetch(`https://thread.internal${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    .then(async (response) => {
      const parsed = (await response.json()) as RpcEnvelope;
      if (!response.ok || !parsed.ok) {
        const error = parsed.ok ? undefined : parsed.error;
        throw new RpcError({
          path,
          kind: error?.kind ?? "malformed",
          message: error?.message ?? `thread rpc ${path} failed (${response.status})`,
          status: response.status,
        });
      }
      return parsed;
    });
};

/**
 * The worker's record for the `/create` RPC: the hub's registry record
 * projected onto the worker's `ThreadRecord` contract (the thread DO
 * decodes `/create` against `ThreadRecordSchema`). The hub's cwd is null
 * for sandbox threads; the worker's is a path.
 */
const workerRecordOf = (record: HubRecord): ThreadRecord => ({
  id: record.id,
  name: record.name,
  cwd: record.cwd ?? "/",
  mode: record.mode,
  createdAt: record.createdAt,
  sessionId: record.sessionId,
  nameAuto: record.autoName,
});

/** The hub's `ThreadWorkerRef` over the thread-DO namespace. */
export const threadWorkerRef = (env: DeploymentEnv): ThreadWorkerRef => ({
  create: (threadId, record) =>
    Effect.tryPromise({
      try: () => threadRpc(env, threadId, "/create", { record: workerRecordOf(record) }),
      catch: toHubError("create thread worker"),
    }).pipe(Effect.andThen(Effect.void)),
  delete: (threadId) =>
    Effect.tryPromise({
      try: () => threadRpc(env, threadId, "/delete", {}),
      catch: toHubError("delete thread worker"),
    }).pipe(Effect.andThen(Effect.void)),
  setEnvHandle: (threadId, handle) =>
    Effect.tryPromise({
      try: () => threadRpc(env, threadId, "/set-env-handle", { handle }),
      catch: toHubError("set env handle"),
    }).pipe(Effect.andThen(Effect.void)),
  command: (threadId, command) =>
    Effect.tryPromise({
      try: () =>
        threadRpc(env, threadId, "/command", { command }).then(
          (parsed) => parsed.payload as WorkerCommandResult,
        ),
      catch: toHubError("thread command"),
    }),
  close: () => Effect.void,
});

/** Set (or clear) a thread's env handle from the hub. */
export const setThreadEnvHandle = (
  env: DeploymentEnv,
  threadId: string,
  handle: EnvHandle | null,
): Effect.Effect<void, HubError, never> =>
  Effect.tryPromise({
    try: () => threadRpc(env, threadId, "/set-env-handle", { handle }),
    catch: toHubError("set env handle"),
  }).pipe(Effect.andThen(Effect.void));

/** The idle-stop controller: arm/disarm the thread DO's durable alarm. */
export const threadIdleStop = (
  env: DeploymentEnv,
): {
  readonly arm: (threadId: string) => Effect.Effect<void, HubError, never>;
  readonly disarm: (threadId: string) => Effect.Effect<void, never, never>;
} => ({
  arm: (threadId) =>
    Effect.tryPromise({
      try: () => threadRpc(env, threadId, "/arm-idle", {}),
      catch: toHubError("arm idle-stop"),
    }).pipe(Effect.andThen(Effect.void)),
  disarm: (threadId) =>
    Effect.tryPromise({
      try: () => threadRpc(env, threadId, "/disarm-idle", {}),
      catch: toHubError("disarm idle-stop"),
    }).pipe(Effect.result, Effect.asVoid),
});

/** Push a report/event/idle-stop firing to the hub (best-effort). */
export const pushToHub = (env: DeploymentEnv, push: HubPush): void => {
  void hubRpc(env, "/push", push).catch((error: unknown) => {
    console.error(`[thread-do] hub push failed: ${String(error)}`);
  });
};
