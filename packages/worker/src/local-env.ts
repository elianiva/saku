/**
 * Local execution environment (local-env.ts): `ExecutionEnv` (pi's
 * `FileSystem & Shell`) implemented over node:fs and node:child_process.
 *
 * This is the "local" half of a thread's hands policy. The daemon runs on the
 * user's machine, so the environment is the machine itself — files under the
 * thread's cwd, shell commands in that cwd.
 */

import {
  appendFile as nodeAppendFile,
  access,
  constants,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { Stats } from "node:fs";
import {
  ExecutionError,
  FileError,
  err,
  ok,
  type ExecutionEnv,
  type FileInfo,
  type Result,
  type ShellExecOptions,
} from "@earendil-works/pi-agent-core";

const mapFileError = (path: string, error: unknown): FileError => {
  const code = (error as NodeJS.ErrnoException).code;
  switch (code) {
    case "ENOENT":
      return new FileError("not_found", `no such file or directory: ${path}`, path, asError(error));
    case "EACCES":
    case "EPERM":
      return new FileError("permission_denied", `permission denied: ${path}`, path, asError(error));
    case "EISDIR":
      return new FileError("is_directory", `is a directory: ${path}`, path, asError(error));
    case "ENOTDIR":
      return new FileError("not_directory", `not a directory: ${path}`, path, asError(error));
    case "EINVAL":
      return new FileError("invalid", `invalid path: ${path}`, path, asError(error));
    default:
      return new FileError("unknown", `filesystem error: ${String(error)}`, path, asError(error));
  }
};

const asError = (error: unknown): Error | undefined =>
  error instanceof Error ? error : error === undefined ? undefined : new Error(String(error));

const absolute = (path: string): string => (isAbsolute(path) ? resolve(path) : resolve(path));

/** Local filesystem + shell. One instance per thread host. */
export class LocalEnv implements ExecutionEnv {
  readonly cwd: string;
  /** Extra environment variables merged over the daemon's own environment. */
  readonly extraEnv: Record<string, string>;

  constructor(cwd: string, extraEnv: Record<string, string> = {}) {
    this.cwd = cwd;
    this.extraEnv = extraEnv;
  }

  absolutePath(path: string): Promise<Result<string, FileError>> {
    return Promise.resolve(ok(absolute(path)));
  }

  joinPath(parts: string[]): Promise<Result<string, FileError>> {
    return Promise.resolve(ok(join(...parts)));
  }

  async readTextFile(path: string): Promise<Result<string, FileError>> {
    try {
      return ok(await readFile(absolute(path), "utf8"));
    } catch (error) {
      return err(mapFileError(path, error));
    }
  }

  async readTextLines(
    path: string,
    options?: { maxLines?: number; abortSignal?: AbortSignal },
  ): Promise<Result<string[], FileError>> {
    try {
      const content = await readFile(absolute(path), { encoding: "utf8", signal: options?.abortSignal });
      const lines = content.split("\n");
      return ok(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines));
    } catch (error) {
      if (options?.abortSignal?.aborted) {
        return err(new FileError("aborted", `aborted reading ${path}`, path));
      }
      return err(mapFileError(path, error));
    }
  }

  async readBinaryFile(path: string, signal?: AbortSignal): Promise<Result<Uint8Array, FileError>> {
    try {
      return ok(await readFile(absolute(path), { signal }));
    } catch (error) {
      return err(mapFileError(path, error));
    }
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
    try {
      await mkdir(dirname(absolute(path)), { recursive: true });
      await writeFile(absolute(path), content);
      return ok(undefined);
    } catch (error) {
      return err(mapFileError(path, error));
    }
  }

  async appendFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
    try {
      await mkdir(dirname(absolute(path)), { recursive: true });
      await nodeAppendFile(absolute(path), content);
      return ok(undefined);
    } catch (error) {
      return err(mapFileError(path, error));
    }
  }

  async renameFile(sourcePath: string, destinationPath: string): Promise<Result<void, FileError>> {
    try {
      await rename(absolute(sourcePath), absolute(destinationPath));
      return ok(undefined);
    } catch (error) {
      return err(mapFileError(sourcePath, error));
    }
  }

  async fileInfo(path: string): Promise<Result<FileInfo, FileError>> {
    try {
      const stats = await lstat(absolute(path));
      return ok(toFileInfo(path, stats));
    } catch (error) {
      return err(mapFileError(path, error));
    }
  }

  async listDir(path: string, signal?: AbortSignal): Promise<Result<FileInfo[], FileError>> {
    try {
      const dir = absolute(path);
      const names = await readdir(dir, { withFileTypes: true });
      const infos: FileInfo[] = [];
      for (const entry of names) {
        const entryPath = join(dir, entry.name);
        let kind: FileInfo["kind"];
        if (entry.isSymbolicLink()) {
          kind = "symlink";
        } else if (entry.isDirectory()) {
          kind = "directory";
        } else {
          kind = "file";
        }
        let size = 0;
        let mtimeMs = 0;
        try {
          const stats = await stat(entryPath);
          size = stats.size;
          mtimeMs = stats.mtimeMs;
        } catch {
          // Broken symlink or racing removal: report the entry without size/mtime.
        }
        infos.push({ name: entry.name, path: entryPath, kind, size, mtimeMs });
      }
      return ok(infos);
    } catch (error) {
      return err(mapFileError(path, error));
    }
  }

  async canonicalPath(path: string): Promise<Result<string, FileError>> {
    try {
      return ok(await realpath(absolute(path)));
    } catch (error) {
      return err(mapFileError(path, error));
    }
  }

  async exists(path: string): Promise<Result<boolean, FileError>> {
    try {
      await access(absolute(path), constants.F_OK);
      return ok(true);
    } catch (error) {
      // Missing paths are not errors; anything else surfaces as a FileError.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return ok(false);
      }
      return err(mapFileError(path, error));
    }
  }

  async createDir(
    path: string,
    options?: { recursive?: boolean; abortSignal?: AbortSignal },
  ): Promise<Result<void, FileError>> {
    try {
      await mkdir(absolute(path), { recursive: options?.recursive ?? true });
      return ok(undefined);
    } catch (error) {
      return err(mapFileError(path, error));
    }
  }

  async remove(
    path: string,
    options?: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal },
  ): Promise<Result<void, FileError>> {
    try {
      await rm(absolute(path), {
        recursive: options?.recursive ?? false,
        force: options?.force ?? false,
      });
      return ok(undefined);
    } catch (error) {
      return err(mapFileError(path, error));
    }
  }

  async createTempDir(prefix = "tmp-"): Promise<Result<string, FileError>> {
    try {
      return ok(await mkdtemp(join(tmpdir(), prefix)));
    } catch (error) {
      return err(new FileError("unknown", `failed to create temp dir: ${String(error)}`));
    }
  }

  async createTempFile(options?: { prefix?: string; suffix?: string }): Promise<Result<string, FileError>> {
    try {
      const dir = await mkdtemp(join(tmpdir(), "saku-"));
      const path = join(dir, `${options?.prefix ?? ""}tmp${options?.suffix ?? ""}`);
      await writeFile(path, "");
      return ok(path);
    } catch (error) {
      return err(new FileError("unknown", `failed to create temp file: ${String(error)}`));
    }
  }

  async cleanup(): Promise<void> {
    // Nothing to release.
  }

  // -- Shell ----------------------------------------------------------------

  async exec(command: string, options?: ShellExecOptions): Promise<Result<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }, ExecutionError>> {
    const cwd =
      options?.cwd === undefined ? this.cwd : isAbsolute(options.cwd) ? options.cwd : resolve(this.cwd, options.cwd);
    const env = {
      ...(options?.inheritEnv === false ? {} : process.env),
      ...this.extraEnv,
      ...options?.env,
    };
    const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
    const shellArgs = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];

    let settle!: (result: Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>) => void;
    const promise = new Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>>((resolveResult) => {
      settle = resolveResult;
    });
    const child = spawn(shell, shellArgs, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
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
    const onAbort = (): void => {
      child.kill("SIGTERM");
    };
    options?.abortSignal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      try {
        options?.onStdout?.(text);
      } catch (error) {
        settle(err(new ExecutionError("callback_error", `onStdout failed: ${String(error)}`)));
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      try {
        options?.onStderr?.(text);
      } catch (error) {
        settle(err(new ExecutionError("callback_error", `onStderr failed: ${String(error)}`)));
      }
    });
    child.on("error", (error) => {
      if (timer !== undefined) clearTimeout(timer);
      options?.abortSignal?.removeEventListener("abort", onAbort);
      settle(err(new ExecutionError("spawn_error", `failed to spawn ${shell}: ${error.message}`, error)));
    });
    child.on("close", (code, signal) => {
      if (timer !== undefined) clearTimeout(timer);
      options?.abortSignal?.removeEventListener("abort", onAbort);
      if (timedOut) {
        settle(err(new ExecutionError("timeout", `command timed out after ${options?.timeout}s`)));
        return;
      }
      if (options?.abortSignal?.aborted) {
        settle(err(new ExecutionError("aborted", "command aborted")));
        return;
      }
      if (signal !== null && signal !== undefined && code === null) {
        settle(err(new ExecutionError("aborted", `command terminated by signal ${signal}`)));
        return;
      }
      settle(ok({ stdout, stderr, exitCode: code ?? -1 }));
    });
    return promise;
  }
}

const toFileInfo = (path: string, stats: Stats): FileInfo => ({
  name: path.split(sep).pop() ?? path,
  path: absolute(path),
  kind: stats.isDirectory() ? "directory" : stats.isSymbolicLink() ? "symlink" : "file",
  size: stats.size,
  mtimeMs: stats.mtimeMs,
});
