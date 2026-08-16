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
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Exit, FileSystem, Schema, Scope } from "effect";
import { EnvDaemon, EnvRelayClient, nodeSocket, RemoteEnv } from "@saku/env";
import type { EnvDaemonApi } from "@saku/env";

import { HubRelay } from "../src/index.ts";
import type { HubRelayApi } from "../src/index.ts";

/** A polling assertion that gave up (the async fork hadn't landed in time). */
// Aliased so the TaggedError class declaration below stays a plain call
// (`new` breaks the schema typecheck — `TaggedError` is a function
// returning a class, not a class).
const tagged = Schema.TaggedError;
class TestError extends tagged<TestError>()("TestError", {
  message: Schema.String,
}) {}

const RELAY_TOKEN = "hub-relay-secret";
const ENV_TOKEN = "env-token";
const ENV_ID = "env_abcdef123456";

describe("hub relay", () => {
  let workdir: string;
  // The env daemon exists so the relay has something to serve; tests reach
  // it through the relay, never by its own URL.
  let _daemon: EnvDaemonApi;
  let relay: HubRelayApi;
  let scope: Scope.Scope;
  let registrationScope: Scope.Scope | undefined;

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "saku-relay-"));
    const built = await Effect.runPromise(
      Effect.gen(function* built() {
        const builtScope = yield* Scope.make();
        const fs = yield* FileSystem.FileSystem;
        const daemon = yield* EnvDaemon.make({ cwd: workdir, fs, token: ENV_TOKEN }).pipe(
          Effect.provideService(Scope.Scope, builtScope),
        );
        const builtRelay = yield* HubRelay.make({ token: RELAY_TOKEN }).pipe(
          Effect.provideService(Scope.Scope, builtScope),
        );
        return { daemon, relay: builtRelay, scope: builtScope };
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    );
    ({ daemon: _daemon, relay, scope } = built);
  });

  afterEach(async () => {
    if (registrationScope !== undefined) {
      await Effect.runPromise(Scope.close(registrationScope, Exit.void));
    }
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await rm(workdir, { force: true, recursive: true });
  });

  /** Poll until `fn` holds (the relay's async forks land asynchronously). */
  const waitFor = (fn: () => boolean | Promise<boolean>, timeoutMs = 2000) =>
    Effect.gen(function* poll() {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const done = yield* Effect.promise(async () => await fn());
        if (done) {
          return;
        }
        yield* Effect.sleep("10 millis");
      }
      yield* Effect.fail(new TestError({ message: "condition not met" }));
    });

  /** Register the env daemon with the relay and wait for the registration. */
  const register = async () => {
    registrationScope = await Effect.runPromise(
      Effect.gen(function* registerScope() {
        const regScope = yield* Scope.make();
        const fs = yield* FileSystem.FileSystem;
        yield* EnvRelayClient.make({
          envId: ENV_ID,
          fs,
          hello: { cwd: workdir, token: ENV_TOKEN, version: "1" },
          token: RELAY_TOKEN,
          url: relay.url,
        }).pipe(Effect.provideService(Scope.Scope, regScope));
        return regScope;
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    );
    await Effect.runPromise(
      waitFor(async () => {
        const registered = await Effect.runPromise(relay.registered());
        return registered.includes(ENV_ID);
      }),
    );
  };

  it("pipes a worker's RemoteEnv to the registered daemon: hello + exec through the relay", async () => {
    await register();
    const env = new RemoteEnv({
      cwd: workdir,
      relay: { envId: ENV_ID, token: RELAY_TOKEN },
      socket: nodeSocket,
      token: ENV_TOKEN,
      url: relay.url,
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
      cwd: workdir,
      relay: { envId: ENV_ID, token: "wrong" },
      socket: nodeSocket,
      token: ENV_TOKEN,
      url: relay.url,
    });
    await expect(env.connect()).rejects.toThrow("invalid relay token");
  });

  it("fails an attach for an env that never registered", async () => {
    const env = new RemoteEnv({
      cwd: workdir,
      relay: { envId: "env_unknown", token: RELAY_TOKEN },
      socket: nodeSocket,
      token: ENV_TOKEN,
      url: relay.url,
    });
    await expect(env.connect()).rejects.toThrow(/no env registered/u);
  });

  it("rejects a daemon registration with a bad token", async () => {
    await Effect.runPromise(
      Effect.gen(function* badRegistration() {
        const badScope = yield* Scope.make();
        const fs = yield* FileSystem.FileSystem;
        yield* EnvRelayClient.make({
          envId: "env_bad",
          fs,
          hello: { cwd: workdir, token: ENV_TOKEN, version: "1" },
          token: "wrong",
          url: relay.url,
        }).pipe(Effect.provideService(Scope.Scope, badScope));
        // The registration loop retries forever; give it one beat, then
        // verify the hub never recorded the env.
        yield* Effect.sleep("300 millis");
        yield* Scope.close(badScope, Exit.void);
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    );
    const registered = await Effect.runPromise(relay.registered());
    expect(registered).not.toContain("env_bad");
  });

  it("pipes a worker that attached before the daemon registered", async () => {
    const env = new RemoteEnv({
      cwd: workdir,
      relay: { envId: ENV_ID, token: RELAY_TOKEN },
      socket: nodeSocket,
      token: ENV_TOKEN,
      url: relay.url,
    });
    const connecting = env.connect();
    await Effect.runPromise(Effect.sleep("150 millis"));
    await register();
    await connecting;
    const exec = await env.exec("echo late attach works");
    expect(exec.ok && exec.value.stdout).toContain("late attach works");
    env.close();
  });
});
