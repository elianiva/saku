/**
 * The M4 integration suite (deploy.test.ts): the durable spine end to
 * end, in real workerd — the alchemy dev harness deploys the stack (the
 * same program Cloudflare and celld run) to a local workerd, and the
 * tests drive it over the real wire:
 *
 * - a real env daemon (node, in-process) is the static provisioner's env
 * - the hub DO serves `/ws` (wire) and `/relay` from the shared cores
 * - the thread DO runs the real `SessionHost` over DO storage with the
 *   scripted provider (no LLM keys needed)
 * - the idle-stop window is a DO alarm (armed by the hub's controller,
 *   fired in the thread DO, pulled by the hub)
 *
 * This is the proof of ADR 0001–0004 on the deployment's own code: the
 * same `src/` is what `bun alchemy deploy` and `celld deploy` ship.
 *
 * Harness notes: `sidecar: false` runs the dev providers in-process (the
 * sidecar's `Layer.build` call shapes broke against effect beta.106), and
 * the wire client lives inside each test's effect (its actor is forked
 * from the harness runtime, so a one-shot `runPromise` would kill it).
 */

import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Redacted from "effect/Redacted";
import * as Effect from "effect/Effect";
import { Exit, FileSystem, Scope } from "effect";
import { NodeFileSystem } from "@effect/platform-node";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeEnvDaemon, makeEnvRelayClient, nodeSocket, RemoteEnv } from "@saku/env";
import { makeWireClient, type WireClient } from "@saku/wire";

import { makeStack } from "../alchemy.run.ts";

const TOKEN = "deploy-test-token";
const ENV_TOKEN = "deploy-env-token";
const IDLE_STOP_MS = 800;

const { test: t, beforeAll: harnessBeforeAll, afterAll: harnessAfterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
  dev: true,
  // The dev sidecar proxies providers into a child process; its
  // `Layer.build`/`Effect.provide` call shapes broke against effect
  // beta.106 — in-process providers run the same workerd.
  sidecar: false,
  stage: "saku-m4",
});

// The env daemon: the static provisioner's env (a real daemon the thread
// DO's RemoteEnv connects to from inside workerd). It must exist before
// the stack deploys (the envUrl binding is a Config default), so it is
// built at module level and torn down in afterAll.
const daemonScope = await Effect.runPromise(Scope.make());
const daemonFs = await Effect.runPromise(
  FileSystem.FileSystem.pipe(Effect.provide(NodeFileSystem.layer)),
);
const daemonWorkdir = await mkdtemp(join(tmpdir(), "saku-deploy-"));
const daemon = await Effect.runPromise(
  makeEnvDaemon({ token: ENV_TOKEN, fs: daemonFs, cwd: daemonWorkdir }).pipe(
    Effect.provideService(Scope.Scope, daemonScope),
  ),
);

// The stack itself deploys through the harness (real workerd on a local
// port).
const stack = harnessBeforeAll(
  deploy(
    makeStack({
      secret: Redacted.make(TOKEN),
      provisioner: "static",
      envUrl: daemon.url,
      envToken: ENV_TOKEN,
      fakeModel: true,
      idleStopMs: IDLE_STOP_MS,
    }),
  ),
);

harnessAfterAll(
  destroy(makeStack()).pipe(
    Effect.andThen(
      Scope.close(daemonScope, Exit.void).pipe(
        Effect.orDie,
        Effect.andThen(
          Effect.tryPromise(() => rm(daemonWorkdir, { recursive: true, force: true })).pipe(
            Effect.orDie,
          ),
        ),
      ),
    ),
  ),
);

// -- helpers ----------------------------------------------------------------

/** A fresh console for a test: connect inside the harness runtime. */
const consoleFor = (url: string | undefined): Effect.Effect<WireClient, never, never> =>
  Effect.gen(function* () {
    if (url === undefined) {
      return yield* Effect.die(new Error("stack deployed without a url"));
    }
    const client = yield* makeWireClient({ url: `${url}/ws`, token: TOKEN, role: "cli" });
    yield* client.connect();
    return client;
  }).pipe(Effect.orDie);

/**
 * Poll an effect until its value satisfies the predicate. The sleep below
 * is a real-time poll over actual workerd sockets and DO storage — a
 * TestClock cannot advance that I/O, so the loop is the test's clock.
 */
const waitFor = <A>(
  effect: Effect.Effect<A, never, never>,
  predicate: (value: A) => boolean,
  what: string,
  timeoutMs = 20_000,
): Effect.Effect<A, never, never> => {
  const deadline = Date.now() + timeoutMs;
  const loop = (): Effect.Effect<A, never, never> =>
    Effect.gen(function* () {
      const value = yield* effect;
      if (predicate(value)) return value;
      if (Date.now() > deadline) {
        return yield* Effect.die(new Error(`timed out waiting for ${what}`));
      }
      return yield* Effect.sleep(100).pipe(Effect.andThen(loop));
    });
  return loop();
};

const entriesOf = (client: WireClient, threadId: string): Effect.Effect<unknown[], never, never> =>
  Effect.gen(function* () {
    const result = yield* client.getEntries(threadId, 0).pipe(Effect.orDie);
    return [...result.entries];
  });

/** The human-readable text of an entry (structured pi content flattened). */
const entryText = (entry: unknown): string => {
  const e = entry as {
    type?: string;
    content?: unknown;
    message?: { role?: string; content?: unknown };
  };
  if (e.type !== "message") return "";
  const content = e.message?.content ?? e.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const p = part as { type?: string; text?: string };
        return p.type === "text" ? (p.text ?? "") : "";
      })
      .join("");
  }
  return "";
};

/** The thread_changed events seen so far (the fan-out proves the hub DO). */
const makeThreadWatcher = (client: WireClient) => {
  const events: Array<{ state: string; env: string }> = [];
  const off = client.on("thread_changed", (payload) => {
    const thread = payload as unknown as { state?: string; env?: string };
    events.push({ state: String(thread.state), env: String(thread.env) });
  });
  return { events, off };
};

// -- the spine --------------------------------------------------------------

t("a console drives a thread through the deployed hub and thread DO",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* consoleFor(url);
    const watcher = makeThreadWatcher(client);

    const created = yield* client.createThread("deploy-test", { mode: "sandbox" });
    expect(created.id.length).toBe(32);

    // The run: the env is provisioned lazily on the first mutating command
    // (ADR 0003) — the static provisioner flips the axis to ready — and the
    // scripted provider answers, growing the trail in DO storage.
    yield* client.prompt(created.id, "hello");
    yield* waitFor(
      client.getThread(created.id).pipe(Effect.orDie),
      (thread) => thread.env === "ready",
      "env ready (lazy provisioning on first prompt)",
    );
    const entries = yield* waitFor(
      entriesOf(client, created.id),
      (list) => list.length >= 2,
      "run entries",
    );
    const texts = entries
      .map((entry) => entryText(entry))
      .join("\n");
    expect(texts).toContain("Hello from the saku-fake model.");

    // The hub DO fanned the events out (state went working → idle).
    yield* waitFor(
      Effect.sync(() => watcher.events),
      (events) => events.some((e) => e.state === "working"),
      "working broadcast",
    );
    yield* waitFor(
      Effect.sync(() => watcher.events),
      (events) => events.some((e) => e.state === "idle"),
      "idle broadcast",
    );
    watcher.off();
  }).pipe(Effect.timeout("1 minutes")),
);

t("idle-stop fires in the thread DO's alarm and the hub stops the env",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* consoleFor(url);
    const watcher = makeThreadWatcher(client);
    const created = yield* client.createThread("idle-test", { mode: "sandbox" });
    // Lazy provisioning: the first prompt flips the env axis to ready.
    yield* client.prompt(created.id, "hello again");
    yield* waitFor(
      client.getThread(created.id).pipe(Effect.orDie),
      (thread) => thread.env === "ready",
      "env ready",
    );

    // The DO alarm fires after the idle window; the hub flips the env axis.
    yield* waitFor(
      Effect.sync(() => watcher.events),
      (events) => events.some((e) => e.env === "stopped"),
      "env stopped (DO alarm → hub trigger)",
      IDLE_STOP_MS + 15_000,
    );

    // The next prompt resumes: env ready again, the run still works.
    yield* client.prompt(created.id, "one more");
    yield* waitFor(
      client.getThread(created.id).pipe(Effect.orDie),
      (thread) => thread.env === "ready",
      "env resumed",
    );
    const entries = yield* waitFor(
      entriesOf(client, created.id),
      (list) => list.length >= 4,
      "entries after resume",
    );
    expect(entries.length).toBeGreaterThanOrEqual(4);
    watcher.off();
  }).pipe(Effect.timeout("1 minutes")),
);

// -- the relay in the hub DO ------------------------------------------------

t("the env relay lives in the hub DO: register, attach, exec",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const scope = yield* Scope.make();
    const fs = yield* FileSystem.FileSystem.pipe(Effect.provide(NodeFileSystem.layer));
    const relay = yield* makeEnvRelayClient({
      url: `${url}/relay`,
      envId: "relay-test-env",
      token: TOKEN,
      hello: { token: ENV_TOKEN, version: "1", cwd: "/tmp" },
      fs,
    }).pipe(Effect.provideService(Scope.Scope, scope));
    try {
      // A worker-side RemoteEnv attaches through the DO and drives the daemon.
      const env = new RemoteEnv({
        url: `${url}/relay`,
        token: ENV_TOKEN,
        relay: { envId: "relay-test-env", token: TOKEN },
        socket: nodeSocket,
      });
      yield* Effect.tryPromise(() => env.connect());
      const outcome = yield* Effect.tryPromise(() => env.exec("printf relay-through-the-do"));
      if (!outcome.ok) throw new Error(`exec failed: ${outcome.error.message}`);
      expect(outcome.value.stdout).toBe("relay-through-the-do");
      expect(outcome.value.exitCode).toBe(0);
      env.close();
    } finally {
      yield* relay.stop();
      yield* Scope.close(scope, Exit.void);
    }
  }).pipe(Effect.timeout("1 minutes")),
);

// -- teardown ---------------------------------------------------------------

t("delete_thread removes the thread (record + worker storage)",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* consoleFor(url);
    const created = yield* client.createThread("delete-me", { mode: "sandbox" });
    yield* client.deleteThread(created.id);
    const threads = yield* client.listThreads();
    expect(threads.find((thread) => thread.id === created.id)).toBeUndefined();
  }).pipe(Effect.timeout("1 minutes")),
);
