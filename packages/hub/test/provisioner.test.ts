/**
 * The provisioner's contract (ADR 0003): lazy Box creation on first
 * touch, daemon bootstrap through the box's one-shot commands/files API,
 * health-probe before `ready`, resume after idle-stop, release on thread
 * deletion. The Box API is a scripted stub; the env daemon on the far
 * side is REAL (a `makeEnvDaemon` on a random port whose URL the stub's
 * `host.url` returns) — so the probe, the token hand-off, and the resume
 * re-probe are exercised over a real env protocol connection.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Exit, FileSystem, Option, Scope } from "effect";
import { makeEnvDaemon, type EnvDaemonShape } from "@saku/env";

import {
  makeProvisioner,
  type BoxApi,
  type BoxInfo,
  type CommandResult,
  type EnvProvisioner,
} from "../src/index.ts";

const TOKEN = "box-env-token";

/**
 * A scripted box: provisioning is instant, files land in a map, commands
 * succeed (the bootstrap's systemctl line included), and `host.url`
 * reports the real env daemon the test started. Captures every command
 * and lifecycle call for assertions.
 */
const fakeBox = (deps: { daemonUrl: () => string | null }): BoxApi & {
  readonly commands: string[];
  readonly stopped: string[];
  readonly resumed: string[];
  readonly files: Map<string, Map<string, string>>;
  readonly hostUrlReads: number;
} => {
  const files = new Map<string, Map<string, string>>();
  const commands: string[] = [];
  const stopped: string[] = [];
  const resumed: string[] = [];
  let next = 0;
  let hostUrlReads = 0;

  const boxOf = (id: string): BoxInfo => ({ id, status: "ready" });
  return {
    createBox: () =>
      Effect.succeed({
        id: `bx_fake${++next}`,
        status: "provisioning",
      }),
    getBox: (id) => Effect.succeed(boxOf(id)),
    runCommand: (_id, command) => {
      commands.push(command);
      return Effect.succeed({
        stdout: "ok",
        stderr: "",
        exitCode: 0,
        success: true,
      } satisfies CommandResult);
    },
    writeFile: (id, path, content) =>
      Effect.sync(() => {
        const dir = files.get(id) ?? new Map<string, string>();
        dir.set(path, content);
        files.set(id, dir);
      }),
    readFile: (id, path) => {
      if (path.endsWith("host.url")) {
        hostUrlReads += 1;
        const url = deps.daemonUrl();
        if (url !== null) return Effect.succeed(`${url}\n`);
        return Effect.succeed("");
      }
      return Effect.succeed(files.get(id)?.get(path) ?? "");
    },
    stop: (id) =>
      Effect.sync(() => {
        stopped.push(id);
      }),
    resume: (id) =>
      Effect.sync(() => {
        resumed.push(id);
      }),
    commands,
    stopped,
    resumed,
    files,
    get hostUrlReads() {
      return hostUrlReads;
    },
  };
};

describe("makeProvisioner", () => {
  let workdir: string;
  let daemon: EnvDaemonShape;
  let scope: Scope.Scope;
  let daemonUrl: string | null;
  let box: ReturnType<typeof fakeBox>;
  let provisioner: EnvProvisioner;
  const thread = {
    id: "thread1234567890",
    name: "boxed",
    cwd: null,
    mode: "sandbox" as const,
    autoName: true,
    createdAt: 0,
    sessionId: null,
    env: "stopped" as const,
    envHandle: null,
  };

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "saku-box-"));
    daemon = await Effect.runPromise(
      Effect.gen(function* () {
        scope = yield* Scope.make();
        const fs = yield* FileSystem.FileSystem;
        return yield* makeEnvDaemon({ token: TOKEN, fs, cwd: workdir }).pipe(
          Effect.provideService(Scope.Scope, scope),
        );
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    );
    daemonUrl = daemon.url;
    box = fakeBox({ daemonUrl: () => daemonUrl });
    provisioner = makeProvisioner({
      boxApi: box,
      readBundle: () => Effect.succeed("// bundle"),
      envToken: () => TOKEN,
    });
  });

  afterEach(async () => {
    daemonUrl = null;
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await rm(workdir, { recursive: true, force: true });
  });

  it("provisions a sandbox thread: creates the box, bootstraps, probes, returns the handle", async () => {
    const handle = await Effect.runPromise(provisioner.ensure(thread, Option.none()));
    expect(Option.isSome(handle)).toBe(true);
    if (Option.isNone(handle)) return;
    expect(handle.value.boxId).toMatch(/^bx_fake/);
    expect(handle.value.url).toBe(daemon.url);
    expect(handle.value.token).toBe(TOKEN);

    // The bootstrap: bundle + unit + wrapper uploaded, node ensured,
    // systemd install run, and the daemon's URL read from host.url.
    const boxId = handle.value.boxId ?? "";
    const bundle = box.files.get(boxId)?.get("/home/user/.saku-env/entry.bundle.js") ?? "";
    expect(bundle).toBe("// bundle");
    const unit = box.files.get(boxId)?.get("/home/user/.saku-env/saku-env.service") ?? "";
    expect(unit).toContain(`SAKU_ENV_TOKEN=${TOKEN}`);
    expect(unit).toContain("ExecStart=/home/user/.saku-env/run.sh");
    expect(box.commands.some((c) => c.includes("node-") && c.includes("tar.xz"))).toBe(true);
    expect(box.commands.some((c) => c.includes("systemctl enable --now saku-env"))).toBe(true);
    expect(box.hostUrlReads).toBeGreaterThan(0);
  });

  it("provisions locally without a handle (the local env daemon serves them)", async () => {
    const local = { ...thread, mode: "local" as const };
    const handle = await Effect.runPromise(provisioner.ensure(local, Option.none()));
    expect(Option.isNone(handle)).toBe(true);
    expect(box.commands).toHaveLength(0);
  });

  it("resumes a stopped box: wakes it, re-probes the stored URL", async () => {
    const handle = await Effect.runPromise(provisioner.ensure(thread, Option.none()));
    if (Option.isNone(handle)) return;
    // Idle-stop put the box to sleep; the next prompt resumes it.
    const again = await Effect.runPromise(provisioner.ensure(thread, Option.some(handle.value)));
    expect(Option.isSome(again)).toBe(true);
    if (Option.isNone(again)) return;
    expect(again.value.url).toBe(daemon.url);
    expect(box.resumed).toEqual([handle.value.boxId]);
    expect(box.stopped).toHaveLength(0);
  });

  it("re-reads host.url when the stored URL stopped answering (host restart)", async () => {
    const handle = await Effect.runPromise(provisioner.ensure(thread, Option.none()));
    if (Option.isNone(handle)) return;
    // The daemon restarted behind a different host URL; the stored one is dead.
    const fresh = await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const fs = yield* FileSystem.FileSystem;
        const restarted = yield* makeEnvDaemon({ token: TOKEN, fs, cwd: workdir }).pipe(
          Effect.provideService(Scope.Scope, scope),
        );
        return { restarted, scope };
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    );
    // The box's host.url now reflects the restarted daemon.
    daemonUrl = fresh.restarted.url;
    const staleHandle = { ...handle.value, url: "ws://127.0.0.1:1" };
    const resumed = await Effect.runPromise(
      provisioner.ensure(thread, Option.some(staleHandle)),
    );
    await Effect.runPromise(Scope.close(fresh.scope, Exit.void));
    expect(Option.isSome(resumed)).toBe(true);
    if (Option.isNone(resumed)) return;
    expect(resumed.value.url).toBe(fresh.restarted.url);
  });

  it("releases a sandbox thread by stopping its box; local threads never stop", async () => {
    const handle = await Effect.runPromise(provisioner.ensure(thread, Option.none()));
    if (Option.isNone(handle)) return;
    await Effect.runPromise(provisioner.release(thread.id, Option.some(handle.value)));
    expect(box.stopped).toEqual([handle.value.boxId]);

    await Effect.runPromise(provisioner.release(thread.id, Option.none()));
    expect(box.stopped).toHaveLength(1);
  });
});
