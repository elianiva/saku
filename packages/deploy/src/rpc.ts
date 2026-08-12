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

import { Effect } from "effect";
import type { ResponsePayload, SessionCommand, SessionWireEvent } from "@saku/wire";
import type { EnvHandle } from "@saku/env/remote";
import {
  HubError,
  type HubRecord,
  type ThreadWorkerRef,
  type WorkerCommandResult,
  type WorkerReport,
} from "@saku/hub/core";

import { HUB_INSTANCE, type DeploymentEnv } from "./env.ts";

/** A JSON response from a DO endpoint. */
interface RpcResponse {
  readonly ok: boolean;
  readonly payload?: unknown;
  readonly error?: string;
}

const toHubError =
  (context: string) =>
  (error: unknown): HubError =>
    new HubError({
      message: `${context}: ${error instanceof Error ? error.message : String(error)}`,
      cause: error,
    });

/** Call one endpoint on the hub DO. */
export const hubRpc = (
  env: DeploymentEnv,
  path: string,
  body: unknown,
): Promise<RpcResponse> => {
  const stub = env.HUB.get(env.HUB.idFromName(HUB_INSTANCE));
  return stub
    .fetch(`https://hub.internal${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    .then(async (response) => {
      const parsed = (await response.json()) as RpcResponse;
      if (!response.ok || !parsed.ok) {
        throw new Error(parsed.error ?? `hub rpc ${path} failed (${response.status})`);
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
): Promise<RpcResponse> => {
  const stub = env.THREAD.get(env.THREAD.idFromName(threadId));
  return stub
    .fetch(`https://thread.internal${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    .then(async (response) => {
      const parsed = (await response.json()) as RpcResponse;
      if (!response.ok || !parsed.ok) {
        throw new Error(parsed.error ?? `thread rpc ${path} failed (${response.status})`);
      }
      return parsed;
    });
};

/** The hub's `ThreadWorkerRef` over the thread-DO namespace. */
export const threadWorkerRef = (env: DeploymentEnv): ThreadWorkerRef => ({
  create: (threadId, record) =>
    Effect.tryPromise({
      try: () => threadRpc(env, threadId, "/create", { record }),
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
export const threadIdleStop = (env: DeploymentEnv): {
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
      catch: () => undefined,
    }).pipe(Effect.catch(() => Effect.void)),
});

/** The push payloads a thread DO sends to the hub DO. */
export type HubPush =
  | { readonly type: "report"; readonly threadId: string; readonly report: WorkerReport }
  | {
      readonly type: "sessionEvent";
      readonly threadId: string;
      readonly event: SessionWireEvent;
      readonly tailSeq: number;
    }
  | { readonly type: "idleStopFired"; readonly threadId: string };

/** Push a report/event/idle-stop firing to the hub (best-effort). */
export const pushToHub = (env: DeploymentEnv, push: HubPush): void => {
  void hubRpc(env, "/push", push).catch((error: unknown) => {
    console.error(`[thread-do] hub push failed: ${String(error)}`);
  });
};
