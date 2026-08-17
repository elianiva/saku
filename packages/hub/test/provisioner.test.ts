/**
 * The Box provisioner contract: lazy remote-machine creation on first touch,
 * daemon bootstrap through the Box adapter's one-shot commands/files API,
 * health-probe before `ready`, resume after idle-stop, and suspension on
 * release. The provider is a scripted stub; the env daemon on the far side
 * is REAL, so probing, token hand-off, and resume re-probing use the actual
 * env protocol.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Exit, FileSystem, Scope } from "effect";
import { EnvDaemon } from "@saku/env";
import type { EnvDaemonApi } from "@saku/env";

import { BoxProvisioner } from "../src/providers/box.ts";
import type { CommandResult, EnvProvisioner, RemoteMachineProvider } from "../src/index.ts";

const TOKEN = "box-env-token";

interface FakeBox extends RemoteMachineProvider<never> {
  readonly commands: string[];
  readonly stopped: string[];
  readonly resumed: string[];
  readonly files: Map<string, Map<string, string>>;
  readonly hostUrlReads: number;
}

/**
 * A scripted Box: provisioning is instant, files land in a map, commands
 * succeed, and host.url reports the real env daemon the test started.
 */
const fakeBox = (deps: { daemonUrl: () => string | null }) => {
  const files = new Map<string, Map<string, string>>();
  const commands: string[] = [];
  const stopped: string[] = [];
  const resumed: string[] = [];
  let next = 0;
  let hostUrlReads = 0;

  return {
    commands,
    create: () => {
      next += 1;
      return Effect.succeed({
        id: `bx_fake${next}`,
        status: "provisioning",
      });
    },
    files,
    get: (id: string) => Effect.succeed({ id, status: "ready" }),
    get hostUrlReads() {
      return hostUrlReads;
    },
    isReady: (machine) => machine.status === "ready",
    readFile: (id: string, filePath: string) => {
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
    resume: (id: string) =>
      Effect.sync(() => {
        resumed.push(id);
      }),
    resumed,
    runCommand: (_id: string, command: string) => {
      commands.push(command);
      return Effect.succeed({
        exitCode: 0,
        stderr: "",
        stdout: "ok",
        success: true,
      } satisfies CommandResult);
    },
    stopped,
    suspend: (id: string) =>
      Effect.sync(() => {
        stopped.push(id);
      }),
    writeFile: (id: string, filePath: string, content: string) =>
      Effect.sync(() => {
        const dir = files.get(id) ?? new Map<string, string>();
        dir.set(filePath, content);
        files.set(id, dir);
      }),
  } satisfies FakeBox;
};

describe("BoxProvisioner.make", () => {
  let workdir: string;
  let daemon: EnvDaemonApi;
  let scope: Scope.Scope;
  let daemonUrl: string | null;
  let box: FakeBox;
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
    remoteMachineId: null,
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
    provisioner = BoxProvisioner.make({
      envToken: () => TOKEN,
      readBundle: () => Effect.succeed("// bundle"),
      remoteMachineProvider: box,
    });
  });

  afterEach(async () => {
    daemonUrl = null;
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await rm(workdir, { force: true, recursive: true });
  });

  it("provisions a sandbox thread: creates the machine, bootstraps, probes, returns both values", async () => {
    const provisioned = await Effect.runPromise(provisioner.ensure(thread, null, null));
    expect(provisioned.remoteMachineId).toMatch(/^bx_fake/u);
    expect(provisioned.handle).not.toBeNull();
    if (provisioned.handle === null) {
      return;
    }
    expect(provisioned.handle.url).toBe(daemon.url);
    expect(provisioned.handle.token).toBe(TOKEN);

    // The bootstrap: bundle + unit + wrapper uploaded, node ensured,
    // systemd install run, and the daemon's URL read from host.url.
    const machineId = provisioned.remoteMachineId;
    if (machineId === null) {
      return;
    }
    const bundle = box.files.get(machineId)?.get("/home/user/.saku-env/entry.bundle.js") ?? "";
    expect(bundle).toBe("// bundle");
    const unit = box.files.get(machineId)?.get("/home/user/.saku-env/saku-env.service") ?? "";
    expect(unit).toContain(`SAKU_ENV_TOKEN=${TOKEN}`);
    expect(unit).toContain("ExecStart=/home/user/.saku-env/run.sh");
    expect(
      box.commands.some((command) => command.includes("node-") && command.includes("tar.xz")),
    ).toBe(true);
    expect(
      box.commands.some((command) => command.includes("systemctl enable --now saku-env")),
    ).toBe(true);
    expect(box.hostUrlReads).toBeGreaterThan(0);
  });

  it("provisions locally without a remote machine or handle", async () => {
    const local = { ...thread, mode: "local" as const };
    const provisioned = await Effect.runPromise(provisioner.ensure(local, null, null));
    expect(provisioned).toEqual({ handle: null, remoteMachineId: null });
    expect(box.commands).toHaveLength(0);
  });

  it("resumes a suspended machine and re-probes the stored URL", async () => {
    const provisioned = await Effect.runPromise(provisioner.ensure(thread, null, null));
    if (provisioned.handle === null || provisioned.remoteMachineId === null) {
      return;
    }
    const again = await Effect.runPromise(
      provisioner.ensure(thread, provisioned.remoteMachineId, provisioned.handle),
    );
    expect(again.handle?.url).toBe(daemon.url);
    expect(box.resumed).toEqual([provisioned.remoteMachineId]);
    expect(box.stopped).toHaveLength(0);
  });

  it("re-reads host.url when the stored URL stopped answering", async () => {
    const provisioned = await Effect.runPromise(provisioner.ensure(thread, null, null));
    if (provisioned.handle === null || provisioned.remoteMachineId === null) {
      return;
    }
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
    daemonUrl = fresh.restarted.url;
    const staleHandle = { ...provisioned.handle, url: "ws://127.0.0.1:1" };
    const resumed = await Effect.runPromise(
      provisioner.ensure(thread, provisioned.remoteMachineId, staleHandle),
    );
    await Effect.runPromise(Scope.close(fresh.scope, Exit.void));
    expect(resumed.handle?.url).toBe(fresh.restarted.url);
  });

  it("suspends a sandbox machine on release; local threads never suspend", async () => {
    const provisioned = await Effect.runPromise(provisioner.ensure(thread, null, null));
    if (provisioned.remoteMachineId === null) {
      return;
    }
    await Effect.runPromise(
      provisioner.release(thread.id, provisioned.remoteMachineId, provisioned.handle),
    );
    expect(box.stopped).toEqual([provisioned.remoteMachineId]);

    await Effect.runPromise(provisioner.release(thread.id, null, null));
    expect(box.stopped).toHaveLength(1);
  });
});
