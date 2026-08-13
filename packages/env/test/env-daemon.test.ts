/**
 * The env daemon + RemoteEnv over real WebSockets: the env protocol's
 * contract (ADR 0003) — hello/version/auth, the full tool surface
 * (read/write/bash/edit primitives), streamed exec output, abort, error
 * mapping back into pi's own classes, and workspace-relative paths.
 *
 * Every test runs against a real `makeEnvDaemon` on a random port with a
 * real `RemoteEnv` client — no stubs, no mocks; the protocol itself is the
 * integration seam, exactly like the wire's tests.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Exit, FileSystem, Scope } from "effect";
import { FileError } from "@earendil-works/pi-agent-core";
import { makeEnvDaemon, nodeSocket, RemoteEnv, type EnvDaemonShape } from "../src/index.ts";

const TOKEN = "test-token";

describe("env daemon", () => {
  let workdir: string;
  let daemon: EnvDaemonShape;
  let env: RemoteEnv;
  let scope: Scope.Scope;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "saku-env-"));
    daemon = await Effect.runPromise(
      Effect.gen(function* () {
        scope = yield* Scope.make();
        const fs = yield* FileSystem.FileSystem;
        return yield* makeEnvDaemon({ token: TOKEN, fs, cwd: workdir }).pipe(
          Effect.provideService(Scope.Scope, scope),
        );
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    );
    env = new RemoteEnv({ url: daemon.url, token: TOKEN, socket: nodeSocket, cwd: workdir });
    await env.connect();
  });

  afterEach(async () => {
    env.close();
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await rm(workdir, { recursive: true, force: true });
  });

  it("answers hello with the workspace, pid and version", async () => {
    // connect() already consumed the hello; the payload is verifiable via health.
    const health = await env.health();
    expect(health.ok).toBe(true);
    if (!health.ok) return;
    expect(health.value.cwd).toBe(workdir);
    expect(health.value.pid).toBeGreaterThan(0);
    expect(health.value.version).toBe("1");
  });

  it("rejects a wrong token and a wrong version", async () => {
    const bad = new RemoteEnv({ url: daemon.url, token: "nope", socket: nodeSocket });
    await expect(bad.connect()).rejects.toThrow("invalid token");

    const old = new RemoteEnv({ url: daemon.url, token: TOKEN, socket: nodeSocket });
    // Force a version mismatch by connecting with a stale protocol version:
    // RemoteEnv pins ENV_VERSION, so speak raw frames for this one.
    const raw = new WebSocket(daemon.url);
    await new Promise<void>((resolve) => raw.on("open", () => resolve()));
    const frames: string[] = [];
    raw.on("message", (data) => frames.push(data.toString()));
    raw.send(
      JSON.stringify({ _tag: "env_hello", token: TOKEN, version: "0", cwd: workdir }) + "\n",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    raw.close();
    expect(frames.some((f) => f.includes("version mismatch"))).toBe(true);
  });

  it("writes, reads, appends, renames, and lists files in the workspace", async () => {
    const write = await env.writeFile("hello.txt", "one\n");
    expect(write.ok).toBe(true);

    const read = await env.readTextFile("hello.txt");
    expect(read.ok && read.value).toBe("one\n");

    const append = await env.appendFile("hello.txt", "two\n");
    expect(append.ok).toBe(true);
    const reread = await env.readTextFile("hello.txt");
    expect(reread.ok && reread.value).toBe("one\ntwo\n");

    const lines = await env.readTextLines("hello.txt", { maxLines: 1 });
    expect(lines.ok && lines.value).toEqual(["one"]);

    const rename = await env.renameFile("hello.txt", "renamed.txt");
    expect(rename.ok).toBe(true);
    const info = await env.fileInfo("renamed.txt");
    expect(info.ok && info.value.name).toBe("renamed.txt");
    expect(info.ok && info.value.kind).toBe("file");

    const dir = await env.listDir(".");
    expect(dir.ok && dir.value.some((e) => e.name === "renamed.txt")).toBe(true);

    const exists = await env.exists("renamed.txt");
    expect(exists.ok && exists.value).toBe(true);
    const gone = await env.exists("hello.txt");
    expect(gone.ok && gone.value).toBe(false);
  });

  it("resolves relative paths against the connection workspace, not the daemon cwd", async () => {
    // The daemon's own cwd is `workdir`, but the connection pins `workdir/sub`.
    const sub = join(workdir, "sub");
    const dir = await env.createDir("sub");
    expect(dir.ok).toBe(true);
    const inside = new RemoteEnv({ url: daemon.url, token: TOKEN, socket: nodeSocket, cwd: sub });
    await inside.connect();
    const abs = await inside.absolutePath("file.txt");
    expect(abs.ok && abs.value).toBe(join(sub, "file.txt"));
    inside.close();
  });

  it("executes shell commands with streamed output and exit codes", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exec = await env.exec("echo out; echo err >&2; exit 3", {
      onStdout: (text) => stdout.push(text),
      onStderr: (text) => stderr.push(text),
    });
    expect(exec.ok).toBe(true);
    if (!exec.ok) return;
    expect(exec.value.exitCode).toBe(3);
    expect(exec.value.stdout).toContain("out");
    expect(exec.value.stderr).toContain("err");
    expect(stdout.join("")).toContain("out");
    expect(stderr.join("")).toContain("err");
  });

  it("enforces the exec timeout", async () => {
    const exec = await env.exec("sleep 5", { timeout: 1 });
    expect(exec.ok).toBe(false);
    if (exec.ok) return;
    expect(exec.error.code).toBe("timeout");
  });

  it("kills a running exec on abort", async () => {
    const aborter = new AbortController();
    const promise = env.exec("sleep 30", { abortSignal: aborter.signal });
    await new Promise((resolve) => setTimeout(resolve, 200));
    aborter.abort();
    const exec = await promise;
    expect(exec.ok).toBe(false);
    if (exec.ok) return;
    expect(exec.error.code).toBe("aborted");
  });

  it("maps file failures back into pi's FileError classes", async () => {
    const missing = await env.readTextFile("nope.txt");
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error).toBeInstanceOf(FileError);
    expect(missing.error.code).toBe("not_found");
    expect((missing.error as FileError).path).toBe("nope.txt");
  });

  it("round-trips binary content", async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252]);
    const write = await env.writeFile("bin.dat", bytes);
    expect(write.ok).toBe(true);
    const read = await env.readBinaryFile("bin.dat");
    expect(read.ok && Array.from(read.value)).toEqual([0, 1, 2, 250, 251, 252]);
  });

  it("creates temp dirs and files", async () => {
    const dir = await env.createTempDir("saku-");
    expect(dir.ok && dir.value.includes("saku-")).toBe(true);
    const file = await env.createTempFile({ prefix: "saku-f" });
    expect(file.ok && file.value.includes("saku-f")).toBe(true);
    // The suffix rides the wire too (the daemon forwards both fields).
    const suffixed = await env.createTempFile({ prefix: "saku-f", suffix: ".txt" });
    expect(suffixed.ok && suffixed.value.includes("saku-f")).toBe(true);
    expect(suffixed.ok && suffixed.value.endsWith(".txt")).toBe(true);
  });
});
