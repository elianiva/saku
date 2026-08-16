/**
 * Local execution environment (local-env.ts): `ExecutionEnv` (pi's
 * `FileSystem & Shell`) implemented over the `FileSystem` service — the
 * engine of the env daemon (ADR 0003). The daemon runs on the user's
 * machine or in a Box, so the environment is that machine: files under the
 * connection's workspace (`cwd`), shell commands in that cwd.
 *
 * Pi's contract is promise-based (`readTextFile` → `Promise<Result<...>>`),
 * so every operation here runs the `FileSystem` service's effects with
 * `Effect.runPromise` at this promise boundary — failures are captured with
 * `Effect.result`, never try/catch. No node:fs import, no `*Sync` variant.
 * The service instance is injected by the caller (the env daemon, which
 * yields `FileSystem.FileSystem`).
 *
 * Relative paths resolve against the workspace root (`cwd`), never the
 * process cwd — the daemon may be spawned from anywhere, and in a Box the
 * workspace is the box's workdir.
 */

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import pathModule from "node:path";
import type { FileSystem } from "effect";
import { Effect, Match, Option, Result } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { ExecutionError, FileError, err, ok } from "@earendil-works/pi-agent-core";
import type {
  ExecutionEnv,
  FileInfo,
  Result as PiResult,
  ShellExecOptions,
} from "@earendil-works/pi-agent-core";

/** Dig a node errno code out of a PlatformError (the daemon's FileSystem failures). */
const errnoCode = (error: PlatformError): string | undefined =>
  Match.value(error.reason).pipe(
    Match.withReturnType<string | undefined>(),
    Match.when({ _tag: "NotFound" }, () => "ENOENT"),
    Match.when({ _tag: "PermissionDenied" }, () => "EACCES"),
    Match.when({ _tag: "BadResource" }, (reason): string | undefined => {
      const { cause } = reason;
      if (
        cause instanceof Error &&
        "code" in cause &&
        (cause.code === "EISDIR" || cause.code === "ENOTDIR")
      ) {
        return cause.code;
      }
      return undefined;
    }),
    Match.orElse((): string | undefined => undefined),
  );

/** Map a FileSystem failure to pi's FileError, preserving the node errno code. */
const mapFileError = (path: string, error: PlatformError) => {
  const code = errnoCode(error);
  return Match.value(code).pipe(
    Match.withReturnType<FileError>(),
    Match.when(
      "ENOENT",
      () => new FileError("not_found", `no such file or directory: ${path}`, path, error),
    ),
    Match.whenOr(
      "EACCES",
      "EPERM",
      () => new FileError("permission_denied", `permission denied: ${path}`, path, error),
    ),
    Match.when(
      "EISDIR",
      () => new FileError("is_directory", `is a directory: ${path}`, path, error),
    ),
    Match.when(
      "ENOTDIR",
      () => new FileError("not_directory", `not a directory: ${path}`, path, error),
    ),
    Match.when("EINVAL", () => new FileError("invalid", `invalid path: ${path}`, path, error)),
    Match.orElse(() => new FileError("unknown", `filesystem error: ${String(error)}`, path, error)),
  );
};

/**
 * Resolve a path against the workspace root: absolute paths pass through
 * (node's `resolve` handles them), relative ones anchor at the workspace.
 */
const absolute = (cwd: string, path: string) => pathModule.resolve(cwd, path);

/** True when the payload is text; the FileSystem methods branch on this. */
const isText = (content: string | Uint8Array): content is string => typeof content === "string";

/** Encode text content, pass bytes through. */
const toBytes = (content: string | Uint8Array) =>
  isText(content) ? new TextEncoder().encode(content) : content;

/** Resolve a command's cwd against the workspace (absolute paths pass through). */
const resolveCwd = (workspace: string, cwd: string) =>
  pathModule.isAbsolute(cwd) ? cwd : pathModule.resolve(workspace, cwd);

/**
 * The child's environment: the daemon's env (unless `inheritEnv: false`),
 * then the connection's extras, then the per-call env.
 */
const buildEnv = (
  extraEnv: Record<string, string>,
  env: Record<string, string> | undefined,
  inherit: boolean,
): NodeJS.ProcessEnv => {
  const merged: NodeJS.ProcessEnv = {};
  if (inherit) {
    Object.assign(merged, process.env);
  }
  Object.assign(merged, extraEnv, env);
  return merged;
};

/** The temp-file options the daemon forwards (makeTempFile's shape). */
interface TempFileOptions {
  directory: string;
  prefix?: string;
  suffix?: string;
}

/**
 * Kind + size/mtime for one path. Total: symlink reads and stats are
 * themselves effect-fallbacks, so callers never see a throw. One
 * composed effect — the promise boundary is crossed once per call.
 */
const describeEntry = async (fs: FileSystem.FileSystem, path: string) =>
  await Effect.runPromise(
    Effect.gen(function* describe() {
      const isLink = yield* Effect.isSuccess(fs.readLink(path));
      if (isLink) {
        return {
          kind: "symlink" as const,
          mtimeMs: 0,
          name: path.split(pathModule.sep).pop() ?? path,
          path,
          size: 0,
        };
      }
      const stat = yield* fs.stat(path).pipe(Effect.result);
      if (Result.isFailure(stat)) {
        return {
          kind: "file" as const,
          mtimeMs: 0,
          name: path.split(pathModule.sep).pop() ?? path,
          path,
          size: 0,
        };
      }
      const info = stat.success;
      return {
        kind: info.type === "Directory" ? ("directory" as const) : ("file" as const),
        mtimeMs: Option.isSome(info.mtime) ? info.mtime.value.getTime() : 0,
        name: path.split(pathModule.sep).pop() ?? path,
        path,
        size: Number(info.size),
      };
    }),
  );

/** Local filesystem + shell. One instance per env connection. */
export class LocalEnv implements ExecutionEnv {
  readonly cwd: string;
  private readonly fs: FileSystem.FileSystem;
  /** Extra environment variables merged over the daemon's own environment. */
  readonly extraEnv: Record<string, string>;

  /** `cwd` is the workspace root; null falls back to the daemon's own cwd. */
  constructor(
    cwd: string | null,
    fs: FileSystem.FileSystem,
    extraEnv: Record<string, string> = {},
  ) {
    this.cwd = cwd ?? process.cwd();
    this.fs = fs;
    this.extraEnv = extraEnv;
  }

  async absolutePath(path: string): Promise<PiResult<string, FileError>> {
    return await Promise.resolve(ok(absolute(this.cwd, path)));
  }

  async joinPath(parts: string[]): Promise<PiResult<string, FileError>> {
    // joinPath is pure; the instance stays pinned to its workspace via `cwd`.
    void this.cwd;
    return await Promise.resolve(ok(pathModule.join(...parts)));
  }

  async readTextFile(path: string): Promise<PiResult<string, FileError>> {
    const outcome = await Effect.runPromise(
      this.fs.readFileString(absolute(this.cwd, path)).pipe(Effect.result),
    );
    return Result.isSuccess(outcome)
      ? ok(outcome.success)
      : err(mapFileError(path, outcome.failure));
  }

  async readTextLines(
    path: string,
    options?: { maxLines?: number; abortSignal?: AbortSignal },
  ): Promise<PiResult<string[], FileError>> {
    const outcome = await Effect.runPromise(
      this.fs.readFileString(absolute(this.cwd, path)).pipe(Effect.result),
    );
    if (Result.isFailure(outcome)) {
      if (options?.abortSignal?.aborted === true) {
        return err(new FileError("aborted", `aborted reading ${path}`, path));
      }
      return err(mapFileError(path, outcome.failure));
    }
    const lines = outcome.success.split("\n");
    return ok(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines));
  }

  async readBinaryFile(
    path: string,
    signal?: AbortSignal,
  ): Promise<PiResult<Uint8Array, FileError>> {
    const outcome = await Effect.runPromise(
      this.fs.readFile(absolute(this.cwd, path)).pipe(Effect.result),
    );
    if (Result.isFailure(outcome)) {
      if (signal?.aborted === true) {
        return err(new FileError("aborted", `aborted reading ${path}`, path));
      }
      return err(mapFileError(path, outcome.failure));
    }
    return ok(outcome.success);
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<PiResult<void, FileError>> {
    const target = absolute(this.cwd, path);
    const outcome = await Effect.runPromise(
      this.fs
        .makeDirectory(pathModule.dirname(target), { recursive: true })
        .pipe(
          Effect.andThen(
            isText(content)
              ? this.fs.writeFileString(target, content)
              : this.fs.writeFile(target, content),
          ),
        )
        .pipe(Effect.result),
    );
    return Result.isSuccess(outcome)
      ? { ok: true, value: undefined }
      : err(mapFileError(path, outcome.failure));
  }

  async appendFile(path: string, content: string | Uint8Array): Promise<PiResult<void, FileError>> {
    const target = absolute(this.cwd, path);
    const outcome = await Effect.runPromise(
      Effect.scoped(
        this.fs.makeDirectory(pathModule.dirname(target), { recursive: true }).pipe(
          Effect.andThen(this.fs.open(target, { flag: "a" })),
          Effect.andThen((file) => file.writeAll(toBytes(content))),
        ),
      ).pipe(Effect.result),
    );
    return Result.isSuccess(outcome)
      ? { ok: true, value: undefined }
      : err(mapFileError(path, outcome.failure));
  }

  async renameFile(
    sourcePath: string,
    destinationPath: string,
  ): Promise<PiResult<void, FileError>> {
    const outcome = await Effect.runPromise(
      this.fs
        .rename(absolute(this.cwd, sourcePath), absolute(this.cwd, destinationPath))
        .pipe(Effect.result),
    );
    return Result.isSuccess(outcome)
      ? { ok: true, value: undefined }
      : err(mapFileError(sourcePath, outcome.failure));
  }

  async fileInfo(path: string): Promise<PiResult<FileInfo, FileError>> {
    const outcome = await Effect.runPromise(
      // describeEntry is total; a rejection would be a defect (orDie).
      Effect.tryPromise(async () => await describeEntry(this.fs, absolute(this.cwd, path))).pipe(
        Effect.orDie,
        Effect.result,
      ),
    );
    return Result.isSuccess(outcome)
      ? ok(outcome.success)
      : err(mapFileError(path, outcome.failure));
  }

  async listDir(path: string, signal?: AbortSignal): Promise<PiResult<FileInfo[], FileError>> {
    const dir = absolute(this.cwd, path);
    const outcome = await Effect.runPromise(this.fs.readDirectory(dir).pipe(Effect.result));
    if (Result.isFailure(outcome)) {
      if (signal?.aborted === true) {
        return err(new FileError("aborted", `aborted listing ${path}`, path));
      }
      return err(mapFileError(path, outcome.failure));
    }
    const entries = await Promise.all(
      outcome.success.map(async (name) => {
        const entryPath = pathModule.join(dir, name);
        // describeEntry is total; racing removals surface as an entry without size/mtime.
        return await describeEntry(this.fs, entryPath);
      }),
    );
    return ok(entries);
  }

  async canonicalPath(path: string): Promise<PiResult<string, FileError>> {
    const outcome = await Effect.runPromise(
      this.fs.realPath(absolute(this.cwd, path)).pipe(Effect.result),
    );
    return Result.isSuccess(outcome)
      ? ok(outcome.success)
      : err(mapFileError(path, outcome.failure));
  }

  async exists(path: string): Promise<PiResult<boolean, FileError>> {
    const outcome = await Effect.runPromise(
      this.fs.exists(absolute(this.cwd, path)).pipe(Effect.result),
    );
    return Result.isSuccess(outcome)
      ? ok(outcome.success)
      : err(mapFileError(path, outcome.failure));
  }

  async createDir(
    path: string,
    options?: { recursive?: boolean; abortSignal?: AbortSignal },
  ): Promise<PiResult<void, FileError>> {
    const outcome = await Effect.runPromise(
      this.fs
        .makeDirectory(absolute(this.cwd, path), { recursive: options?.recursive ?? true })
        .pipe(Effect.result),
    );
    return Result.isSuccess(outcome)
      ? { ok: true, value: undefined }
      : err(mapFileError(path, outcome.failure));
  }

  async remove(
    path: string,
    options?: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal },
  ): Promise<PiResult<void, FileError>> {
    const outcome = await Effect.runPromise(
      this.fs
        .remove(absolute(this.cwd, path), {
          force: options?.force ?? false,
          recursive: options?.recursive ?? false,
        })
        .pipe(Effect.result),
    );
    return Result.isSuccess(outcome)
      ? { ok: true, value: undefined }
      : err(mapFileError(path, outcome.failure));
  }

  async createTempDir(prefix = "tmp-"): Promise<PiResult<string, FileError>> {
    const outcome = await Effect.runPromise(
      this.fs.makeTempDirectory({ directory: tmpdir(), prefix }).pipe(Effect.result),
    );
    return Result.isSuccess(outcome)
      ? ok(outcome.success)
      : err(new FileError("unknown", `failed to create temp dir: ${String(outcome.failure)}`));
  }

  async createTempFile(options?: {
    prefix?: string;
    suffix?: string;
  }): Promise<PiResult<string, FileError>> {
    const fileOptions: TempFileOptions = { directory: tmpdir() };
    if (options?.prefix !== undefined) {
      fileOptions.prefix = options.prefix;
    }
    if (options?.suffix !== undefined) {
      fileOptions.suffix = options.suffix;
    }
    const outcome = await Effect.runPromise(this.fs.makeTempFile(fileOptions).pipe(Effect.result));
    return Result.isSuccess(outcome)
      ? ok(outcome.success)
      : err(new FileError("unknown", `failed to create temp file: ${String(outcome.failure)}`));
  }

  async cleanup() {
    // Nothing to release; the FileSystem service is caller-owned.
    await Promise.resolve(this.cwd);
  }

  async exec(
    command: string,
    options?: ShellExecOptions,
  ): Promise<PiResult<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
    const cwd = options?.cwd === undefined ? this.cwd : resolveCwd(this.cwd, options.cwd);
    const env = buildEnv(this.extraEnv, options?.env, options?.inheritEnv !== false);
    const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
    const shellArgs = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];

    const child = spawn(shell, shellArgs, {
      cwd,
      detached: process.platform !== "win32",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return await Effect.runPromise(
      Effect.callback<
        PiResult<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>
      >((resume) => {
        const resolveResult = (
          result: PiResult<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>,
        ) => {
          resume(Effect.succeed(result));
        };
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timeoutMs = options?.timeout === undefined ? undefined : options.timeout * 1000;
        const killTree = () => {
          if (process.platform === "win32") {
            // Windows has no process groups; taskkill /T is the tree kill.
            if (child.pid !== undefined) {
              spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
            }
            return;
          }
          if (child.pid === undefined) {
            return;
          }
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            // The group is already gone (the child exited); nothing to kill.
            child.kill("SIGTERM");
          }
        };
        const timer =
          timeoutMs === undefined
            ? undefined
            : setTimeout(() => {
                timedOut = true;
                killTree();
              }, timeoutMs);
        const onAbort = () => {
          killTree();
        };
        options?.abortSignal?.addEventListener("abort", onAbort, { once: true });

        const fail = (error: ExecutionError) => {
          if (timer !== undefined) {
            clearTimeout(timer);
          }
          options?.abortSignal?.removeEventListener("abort", onAbort);
          resolveResult(err(error));
        };

        child.stdout?.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf-8");
          stdout += text;
          const invoked = Result.try(() => options?.onStdout?.(text));
          if (Result.isFailure(invoked)) {
            fail(
              new ExecutionError("callback_error", `onStdout failed: ${String(invoked.failure)}`),
            );
          }
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf-8");
          stderr += text;
          const invoked = Result.try(() => options?.onStderr?.(text));
          if (Result.isFailure(invoked)) {
            fail(
              new ExecutionError("callback_error", `onStderr failed: ${String(invoked.failure)}`),
            );
          }
        });
        child.on("error", (error) => {
          fail(
            new ExecutionError("spawn_error", `failed to spawn ${shell}: ${error.message}`, error),
          );
        });
        child.on("close", (code, signal) => {
          if (timer !== undefined) {
            clearTimeout(timer);
          }
          options?.abortSignal?.removeEventListener("abort", onAbort);
          if (timedOut) {
            resolveResult(
              err(new ExecutionError("timeout", `command timed out after ${options?.timeout}s`)),
            );
            return;
          }
          if (options?.abortSignal?.aborted === true) {
            resolveResult(err(new ExecutionError("aborted", "command aborted")));
            return;
          }
          if (signal !== null && signal !== undefined && code === null) {
            resolveResult(
              err(new ExecutionError("aborted", `command terminated by signal ${signal}`)),
            );
            return;
          }
          resolveResult(ok({ exitCode: code ?? -1, stderr, stdout }));
        });
        // The child's events settle the outcome; release the timer and the abort listener.
        return Effect.sync(() => {
          if (timer !== undefined) {
            clearTimeout(timer);
          }
          options?.abortSignal?.removeEventListener("abort", onAbort);
        });
      }),
    );
  }
}
