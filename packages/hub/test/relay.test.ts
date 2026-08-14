/**
 * The hub relay (relay.ts): the user's machine registers by dialing out
 * (no open ports); a worker's `RemoteEnv` attaches and the hub pipes the
 * two sockets — the env protocol flows through the hub uninterpreted.
 *
 * Real sockets throughout: `HubRelay.make` on a random port, a real env
 * daemon registered through its `EnvRelayClient.make`, and a real
 * `RemoteEnv` attached through the relay. Covers registration, attach,
 * exec through the pipe, auth failures, and unknown envs.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Exit, FileSystem, Schema, Scope } from "effect";
import { EnvDaemon, EnvRelayClient, nodeSocket, RemoteEnv, type EnvDaemonShape } from "@saku/env";

import { HubRelay, type HubRelayShape } from "../src/index.ts";

/** A polling assertion that gave up (the async fork hadn't landed in time). */
class TestError extends Schema.TaggedError<TestError>()("TestError", {
  message: Schema.String,
}) {}

const RELAY_TOKEN = "hub-relay-secret";
const ENV_TOKEN = "env-token";
const ENV_ID = "env_abcdef123456";

describe("hub relay", () => {
  let workdir: string;
  // The env daemon exists so the relay has something to serve; tests reach
  // it through the relay, never by its own URL.
  let _daemon: EnvDaemonShape;
  let relay: HubRelayShape;
  let scope: Scope.Scope;
  let registrationScope: Scope.Scope | undefined;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "saku-relay-"));
    const built = await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const fs = yield* FileSystem.FileSystem;
        const daemon = yield* EnvDaemon.make({ token: ENV_TOKEN, fs, cwd: workdir }).pipe(
          Effect.provideService(Scope.Scope, scope),
        );
        const relay = yield* HubRelay.make({ token: RELAY_TOKEN }).pipe(
          Effect.provideService(Scope.Scope, scope),
        );
        return { scope, daemon, relay };
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    );
    scope = built.scope;
    _daemon = built.daemon;
    relay = built.relay;
  });

  afterEach(async () => {
    if (registrationScope !== undefined) {
      await Effect.runPromise(Scope.close(registrationScope, Exit.void));
    }
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await rm(workdir, { recursive: true, force: true });
  });

  /** Register the env daemon with the relay and wait for the registration. */
  const register = async () => {
    registrationScope = await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const fs = yield* FileSystem.FileSystem;
        yield* EnvRelayClient.make({
          url: relay.url,
          envId: ENV_ID,
          token: RELAY_TOKEN,
          hello: { token: ENV_TOKEN, version: "1", cwd: workdir },
          fs,
        }).pipe(Effect.provideService(Scope.Scope, scope));
        return scope;
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    );
    await waitFor(async () => (await Effect.runPromise(relay.registered())).includes(ENV_ID));
  };

  const waitFor = async (fn: () => boolean | Promise<boolean>, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await fn()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new TestError({ message: "condition not met" });
  };

  it("pipes a worker's RemoteEnv to the registered daemon: hello + exec through the relay", async () => {
    await register();
    const env = new RemoteEnv({
      socket: nodeSocket,
      url: relay.url,
      token: ENV_TOKEN,
      cwd: workdir,
      relay: { envId: ENV_ID, token: RELAY_TOKEN },
    });
    await env.connect();
    const write = await env.writeFile("relayed.txt", "through the relay\n");
    expect(write.ok).toBe(true);
    const read = await env.readTextFile("relayed.txt");
    expect(read.ok && read.value).toBe("through the relay\n");
    const exec = await env.exec("echo relaying works");
    expect(exec.ok && exec.value.stdout).toContain("relaying works");
    env.close();
  });

  it("rejects an attach with a bad relay token", async () => {
    await register();
    const env = new RemoteEnv({
      socket: nodeSocket,
      url: relay.url,
      token: ENV_TOKEN,
      cwd: workdir,
      relay: { envId: ENV_ID, token: "wrong" },
    });
    await expect(env.connect()).rejects.toThrow("invalid relay token");
  });

  it("fails an attach for an env that never registered", async () => {
    const env = new RemoteEnv({
      socket: nodeSocket,
      url: relay.url,
      token: ENV_TOKEN,
      cwd: workdir,
      relay: { envId: "env_unknown", token: RELAY_TOKEN },
    });
    await expect(env.connect()).rejects.toThrow(/no env registered/);
  });

  it("rejects a daemon registration with a bad token", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const fs = yield* FileSystem.FileSystem;
        yield* EnvRelayClient.make({
          url: relay.url,
          envId: "env_bad",
          token: "wrong",
          hello: { token: ENV_TOKEN, version: "1", cwd: workdir },
          fs,
        }).pipe(Effect.provideService(Scope.Scope, scope));
        // The registration loop retries forever; give it one beat, then
        // verify the hub never recorded the env.
        yield* Effect.sleep("300 millis");
        yield* Scope.close(scope, Exit.void);
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    );
    const registered = await Effect.runPromise(relay.registered());
    expect(registered).not.toContain("env_bad");
  });

  it("pipes a worker that attached before the daemon registered", async () => {
    const env = new RemoteEnv({
      socket: nodeSocket,
      url: relay.url,
      token: ENV_TOKEN,
      cwd: workdir,
      relay: { envId: ENV_ID, token: RELAY_TOKEN },
    });
    const connecting = env.connect();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await register();
    await connecting;
    const exec = await env.exec("echo late attach works");
    expect(exec.ok && exec.value.stdout).toContain("late attach works");
    env.close();
  });
});
