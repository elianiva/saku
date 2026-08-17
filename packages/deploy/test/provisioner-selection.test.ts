/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { Effect } from "effect";

import type { HubRecord } from "@saku/hub/core";
import type { DeploymentEnv } from "../src/env.ts";
import { provisionerFor } from "../src/hub-do.ts";

const env = (overrides: Partial<DeploymentEnv> = {}) =>
  // SAFETY: selection tests never use the DO namespaces; provider selection only reads deployment vars.
  ({
    BOX_API_KEY: "",
    DEPLOYMENT_SECRET: "deployment-secret",
    FREESTYLE_API_KEY: "",
    HUB: undefined,
    SAKU_ENV_TOKEN: "env-token",
    SAKU_ENV_URL: "ws://127.0.0.1:4311",
    THREAD: undefined,
    ...overrides,
  }) as DeploymentEnv;

const failureOf = async (effect: Effect.Effect<unknown, unknown>) => {
  try {
    await Effect.runPromise(effect);
    return null;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
};

const sandboxThread: HubRecord = {
  archivedAt: null,
  autoName: false,
  createdAt: 0,
  cwd: null,
  env: "stopped",
  envHandle: null,
  id: "thread-selection",
  mode: "sandbox",
  name: "selection",
  remoteMachineId: null,
  sessionId: null,
};

test("defaults to the static daemon provisioner", async () => {
  const provisioner = await Effect.runPromise(provisionerFor(env()));
  const provisioned = await Effect.runPromise(provisioner.ensure(sandboxThread, null, null));
  expect(provisioned).toEqual({
    handle: { token: "env-token", url: "ws://127.0.0.1:4311" },
    remoteMachineId: null,
  });
});

test("rejects unknown provisioner values instead of selecting Box", async () => {
  const failure = await failureOf(provisionerFor(env({ SAKU_ENV_PROVISIONER: "unknown" })));
  expect(failure).toBe("unknown env provisioner: unknown");
});

test("keeps Freestyle explicit and loud until its backend exists", async () => {
  const failure = await failureOf(provisionerFor(env({ SAKU_ENV_PROVISIONER: "freestyle" })));
  expect(failure).toBe("freestyle provisioner is not implemented yet — see ADR 0008");
});
