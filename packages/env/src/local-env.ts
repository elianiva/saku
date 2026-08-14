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
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { Data, Effect, FileSystem, Match, Option, Result } from "effect";
import {
  ExecutionError,
  FileError,
  err,
  ok,
  type ExecutionEnv,
  type FileInfo,
  type Result as PiResult,
  type ShellExecOptions,
} from "@earendil-works/pi-agent-core";

/** Dig a node errno code out of a PlatformError (or a raw ErrnoException). */
const errnoCode = (error: unknown) => {
  if (typeof error !== "object" || error === null) return undefined;
  const e = error as {
    _tag?: string;
    reason?: { _tag?: string; cause?: unknown };
    cause?: { code?: string };
  };
  if (e._tag === "PlatformError" && e.reason !== undefined) {
    return Match.value(e.reason).pipe(
      Match.withReturnType<string | undefined>(),
      Match.when({ _tag: "NotFound" }, () => "ENOENT"),
      Match.when({ _tag: "PermissionDenied" }, () => "EACCES"),
      Match.when({ _tag: "BadResource" }, (reason) => {
        const code = (reason.cause as NodeJS.ErrnoException | undefined)?.code;
        return code === "EISDIR" || code === "ENOTDIR" ? code : undefined;
      }),
      Match.orElse(() => undefined),
    );
  }
  if (e._tag === "NotFound") return "ENOENT";
  if (e._tag === "PermissionDenied") return "EACCES";
  return (
    (error as NodeJS.ErrnoException).code ?? (e.cause as NodeJS.ErrnoException | undefined)?.code
  );
};

const mapFileError = (path: string, error: unknown) => {
  const code = errnoCode(error);
  return Match.value(code).pipe(
    Match.withReturnType<FileError>(),
    Match.when("ENOENT", () =>
      new FileError("not_found", `no such file or directory: ${path}`, path, asError(error)),
    ),
    Match.whenOr("EACCES", "EPERM", () =>
      new FileError("permission_denied", `permission denied: ${path}`, path, asError(error)),
    ),
    Match.when("EISDIR", () =>
      new FileError("is_directory", `is a directory: ${path}`, path, asError(error)),
    ),
    Match.when("ENOTDIR", () =>
      new FileError("not_directory", `not a directory: ${path}`, path, asError(error)),
    ),
    Match.when("EINVAL", () =>
      new FileError("invalid", `invalid path: ${path}`, path, asError(error)),
    ),
    Match.orElse(() =>
      new FileError("unknown", `filesystem error: ${String(error)}`, path, asError(error)),
    ),
  );
};

const asError = (error: unknown) =>
  error instanceof Error
    ? error
    : error === undefined
      ? undefined
      : new Data.Error({ message: String(error) });

/**
 * Resolve a path against the workspace root: absolute paths pass through
 * (node's `resolve` handles them), relative ones anchor at the workspace.
 */
const absolute = (cwd: string, path: string) => resolve(cwd, path);

const toBytes = (content: string | Uint8Array) =>
  typeof content === "string" ? new TextEncoder().encode(content) : content;

/**
 * Kind + size/mtime for one path. Total: symlink reads and stats are
 * themselves effect-fallbacks, so callers never see a throw. One
 * composed effect — the promise boundary is crossed once per call.
 */
const describeEntry = (fs: FileSystem.FileSystem, path: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const isLink = yield* Effect.isSuccess(fs.readLink(path));
      if (isLink)
        return {
          name: path.split(sep).pop() ?? path,
          path,
          kind: "symlink" as const,
          size: 0,
          mtimeMs: 0,
        };
      const info = yield* fs.stat(path).pipe(Effect.catch(() => Effect.succeed(undefined)));
      if (info === undefined)
        return {
          name: path.split(sep).pop() ?? path,
          path,
          kind: "file" as const,
          size: 0,
          mtimeMs: 0,
        };
      return {
        name: path.split(sep).pop() ?? path,
        path,
        kind: info.type === "Directory" ? ("directory" as const) : ("file" as const),
        size: Number(info.size),
        mtimeMs: Option.isSome(info.mtime) ? info.mtime.value.getTime() : 0,
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

  absolutePath(path: string): Promise<PiResult<string, FileError>> {
    return Promise.resolve(ok(absolute(this.cwd, path)));
  }

  joinPath(parts: string[]): Promise<PiResult<string, FileError>> {
    return Promise.resolve(ok(join(...parts)));
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
      if (options?.abortSignal?.aborted) {
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
      if (signal?.aborted) {
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
        .makeDirectory(dirname(target), { recursive: true })
        .pipe(
          Effect.andThen(
            typeof content === "string"
              ? this.fs.writeFileString(target, content)
              : this.fs.writeFile(target, content),
          ),
        )
        .pipe(Effect.result),
    );
    return Result.isSuccess(outcome) ? ok(undefined) : err(mapFileError(path, outcome.failure));
  }

  async appendFile(path: string, content: string | Uint8Array): Promise<PiResult<void, FileError>> {
    const target = absolute(this.cwd, path);
    const outcome = await Effect.runPromise(
      Effect.scoped(
        this.fs.makeDirectory(dirname(target), { recursive: true }).pipe(
          Effect.andThen(this.fs.open(target, { flag: "a" })),
          Effect.andThen((file) => file.writeAll(toBytes(content))),
        ),
      ).pipe(Effect.result),
    );
    return Result.isSuccess(outcome) ? ok(undefined) : err(mapFileError(path, outcome.failure));
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
      ? ok(undefined)
      : err(mapFileError(sourcePath, outcome.failure));
  }

  async fileInfo(path: string): Promise<PiResult<FileInfo, FileError>> {
    const outcome = await Effect.runPromise(
      // describeEntry is total; a rejection would be a defect (orDie).
      Effect.tryPromise(() => describeEntry(this.fs, absolute(this.cwd, path))).pipe(
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
      if (signal?.aborted) {
        return err(new FileError("aborted", `aborted listing ${path}`, path));
      }
      return err(mapFileError(path, outcome.failure));
    }
    const entries = await Promise.all(
      outcome.success.map(async (name) => {
        const entryPath = join(dir, name);
        // describeEntry is total; racing removals surface as an entry without size/mtime.
        return describeEntry(this.fs, entryPath);
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
    return Result.isSuccess(outcome) ? ok(undefined) : err(mapFileError(path, outcome.failure));
  }

  async remove(
    path: string,
    options?: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal },
  ): Promise<PiResult<void, FileError>> {
    const outcome = await Effect.runPromise(
      this.fs
        .remove(absolute(this.cwd, path), {
          recursive: options?.recursive ?? false,
          force: options?.force ?? false,
        })
        .pipe(Effect.result),
    );
    return Result.isSuccess(outcome) ? ok(undefined) : err(mapFileError(path, outcome.failure));
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
    const outcome = await Effect.runPromise(
      this.fs
        .makeTempFile({
          directory: tmpdir(),
          ...(options?.prefix === undefined ? {} : { prefix: options.prefix }),
          ...(options?.suffix === undefined ? {} : { suffix: options.suffix }),
        })
        .pipe(Effect.result),
    );
    return Result.isSuccess(outcome)
      ? ok(outcome.success)
      : err(new FileError("unknown", `failed to create temp file: ${String(outcome.failure)}`));
  }

  async cleanup() {
    // Nothing to release.
  }

  async exec(
    command: string,
    options?: ShellExecOptions,
  ) {
    const cwd =
      options?.cwd === undefined
        ? this.cwd
        : isAbsolute(options.cwd)
          ? options.cwd
          : resolve(this.cwd, options.cwd);
    const env = {
      ...(options?.inheritEnv === false ? {} : process.env),
      ...this.extraEnv,
      ...options?.env,
    };
    const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
    const shellArgs = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];

    const child = spawn(shell, shellArgs, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    return new Promise<
      PiResult<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>
    >((resolveResult) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timeoutMs = options?.timeout === undefined ? undefined : options.timeout * 1000;
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              child.kill("SIGTERM");
            }, timeoutMs);
      const onAbort = () => {
        child.kill("SIGTERM");
      };
      options?.abortSignal?.addEventListener("abort", onAbort, { once: true });

      const fail = (error: ExecutionError) => {
        if (timer !== undefined) clearTimeout(timer);
        options?.abortSignal?.removeEventListener("abort", onAbort);
        resolveResult(err(error));
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stdout += text;
        const invoked = Result.try(() => options?.onStdout?.(text));
        if (Result.isFailure(invoked)) {
          fail(new ExecutionError("callback_error", `onStdout failed: ${String(invoked.failure)}`));
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stderr += text;
        const invoked = Result.try(() => options?.onStderr?.(text));
        if (Result.isFailure(invoked)) {
          fail(new ExecutionError("callback_error", `onStderr failed: ${String(invoked.failure)}`));
        }
      });
      child.on("error", (error) => {
        fail(
          new ExecutionError("spawn_error", `failed to spawn ${shell}: ${error.message}`, error),
        );
      });
      child.on("close", (code, signal) => {
        if (timer !== undefined) clearTimeout(timer);
        options?.abortSignal?.removeEventListener("abort", onAbort);
        if (timedOut) {
          resolveResult(
            err(new ExecutionError("timeout", `command timed out after ${options?.timeout}s`)),
          );
          return;
        }
        if (options?.abortSignal?.aborted) {
          resolveResult(err(new ExecutionError("aborted", "command aborted")));
          return;
        }
        if (signal !== null && signal !== undefined && code === null) {
          resolveResult(
            err(new ExecutionError("aborted", `command terminated by signal ${signal}`)),
          );
          return;
        }
        resolveResult(ok({ stdout, stderr, exitCode: code ?? -1 }));
      });
    });
  }
}
