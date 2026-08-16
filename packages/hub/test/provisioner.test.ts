/**
 * The provisioner's contract (ADR 0003): lazy Box creation on first
 * touch, daemon bootstrap through the box's one-shot commands/files API,
 * health-probe before `ready`, resume after idle-stop, release on thread
 * deletion. The Box API is a scripted stub; the env daemon on the far
 * side is REAL (a `EnvDaemon.make` on a random port whose URL the stub's
 * `host.url` returns) — so the probe, the token hand-off, and the resume
 * re-probe are exercised over a real env protocol connection.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Exit, FileSystem, Option, Scope } from "effect";
import { EnvDaemon } from "@saku/env";
import type { EnvDaemonApi } from "@saku/env";

import { Provisioner } from "../src/index.ts";
import type { BoxApiContract, CommandResult, EnvProvisioner } from "../src/index.ts";

const TOKEN = "box-env-token";

/** The scripted box's canned status payload for one box. */
const boxOf = (id: string) => ({ id, status: "ready" });

/**
 * A scripted box: provisioning is instant, files land in a map, commands
 * succeed (the bootstrap's systemctl line included), and `host.url`
 * reports the real env daemon the test started. Captures every command
 * and lifecycle call for assertions.
 */
const fakeBox = (deps: {
  daemonUrl: () => string | null;
}): BoxApiContract & {
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

  return {
    commands,
    createBox: () => {
      next += 1;
      return Effect.succeed({
        id: `bx_fake${next}`,
        status: "provisioning",
      });
    },
    files,
    getBox: (id) => Effect.succeed(boxOf(id)),
    get hostUrlReads() {
      return hostUrlReads;
    },
    readFile: (id, filePath) => {
      if (filePath.endsWith("host.url")) {
        hostUrlReads += 1;
        const url = deps.daemonUrl();
        if (url !== null) {
          return Effect.succeed(`${url}\n`);
        }
        return Effect.succeed("");
      }
      return Effect.succeed(files.get(id)?.get(filePath) ?? "");
    },
    resume: (id) =>
      Effect.sync(() => {
        resumed.push(id);
      }),
    resumed,
    runCommand: (_id, command) => {
      commands.push(command);
      return Effect.succeed({
        exitCode: 0,
        stderr: "",
        stdout: "ok",
        success: true,
      } satisfies CommandResult);
    },
    stop: (id) =>
      Effect.sync(() => {
        stopped.push(id);
      }),
    stopped,
    writeFile: (id, filePath, content) =>
      Effect.sync(() => {
        const dir = files.get(id) ?? new Map<string, string>();
        dir.set(filePath, content);
        files.set(id, dir);
      }),
  };
};

describe("Provisioner.make", () => {
  let workdir: string;
  let daemon: EnvDaemonApi;
  let scope: Scope.Scope;
  let daemonUrl: string | null;
  let box: ReturnType<typeof fakeBox>;
  let provisioner: EnvProvisioner;
  const thread = {
    autoName: true,
    createdAt: 0,
    cwd: null,
    env: "stopped" as const,
    envHandle: null,
    id: "thread1234567890",
    mode: "sandbox" as const,
    name: "boxed",
    sessionId: null,
  };

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "saku-box-"));
    const built = await Effect.runPromise(
      Effect.gen(function* buildDaemon() {
        const genScope = yield* Scope.make();
        const fs = yield* FileSystem.FileSystem;
        const api: EnvDaemonApi = yield* EnvDaemon.make({ cwd: workdir, fs, token: TOKEN }).pipe(
          Effect.provideService(Scope.Scope, genScope),
        );
        return { api, scope: genScope };
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    );
    const { api: daemonApi, scope: daemonScope } = built;
    scope = daemonScope;
    daemon = daemonApi;
    daemonUrl = daemon.url;
    box = fakeBox({ daemonUrl: () => daemonUrl });
    provisioner = Provisioner.make({
      boxApi: box,
      envToken: () => TOKEN,
      readBundle: () => Effect.succeed("// bundle"),
    });
  });

  afterEach(async () => {
    daemonUrl = null;
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await rm(workdir, { force: true, recursive: true });
  });

  it("provisions a sandbox thread: creates the box, bootstraps, probes, returns the handle", async () => {
    const handle = await Effect.runPromise(provisioner.ensure(thread, Option.none()));
    expect(Option.isSome(handle)).toBe(true);
    if (Option.isNone(handle)) {
      return;
    }
    expect(handle.value.boxId).toMatch(/^bx_fake/u);
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
    if (Option.isNone(handle)) {
      return;
    }
    // Idle-stop put the box to sleep; the next prompt resumes it.
    const again = await Effect.runPromise(provisioner.ensure(thread, Option.some(handle.value)));
    expect(Option.isSome(again)).toBe(true);
    if (Option.isNone(again)) {
      return;
    }
    expect(again.value.url).toBe(daemon.url);
    expect(box.resumed).toEqual([handle.value.boxId]);
    expect(box.stopped).toHaveLength(0);
  });

  it("re-reads host.url when the stored URL stopped answering (host restart)", async () => {
    const handle = await Effect.runPromise(provisioner.ensure(thread, Option.none()));
    if (Option.isNone(handle)) {
      return;
    }
    // The daemon restarted behind a different host URL; the stored one is dead.
    const fresh = await Effect.runPromise(
      Effect.gen(function* fresh() {
        const freshScope = yield* Scope.make();
        const fs = yield* FileSystem.FileSystem;
        const restarted = yield* EnvDaemon.make({ cwd: workdir, fs, token: TOKEN }).pipe(
          Effect.provideService(Scope.Scope, freshScope),
        );
        return { restarted, scope: freshScope };
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    );
    // The box's host.url now reflects the restarted daemon.
    daemonUrl = fresh.restarted.url;
    const staleHandle = { ...handle.value, url: "ws://127.0.0.1:1" };
    const resumed = await Effect.runPromise(provisioner.ensure(thread, Option.some(staleHandle)));
    await Effect.runPromise(Scope.close(fresh.scope, Exit.void));
    expect(Option.isSome(resumed)).toBe(true);
    if (Option.isNone(resumed)) {
      return;
    }
    expect(resumed.value.url).toBe(fresh.restarted.url);
  });

  it("releases a sandbox thread by stopping its box; local threads never stop", async () => {
    const handle = await Effect.runPromise(provisioner.ensure(thread, Option.none()));
    if (Option.isNone(handle)) {
      return;
    }
    await Effect.runPromise(provisioner.release(thread.id, Option.some(handle.value)));
    expect(box.stopped).toEqual([handle.value.boxId]);

    await Effect.runPromise(provisioner.release(thread.id, Option.none()));
    expect(box.stopped).toHaveLength(1);
  });
});
