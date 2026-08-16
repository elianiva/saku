/**
 * Stub env (stub-env.ts): an in-memory `ExecutionEnv` for worker unit tests.
 * Files live in a `Map`; `exec` records the command and answers with canned
 * output. The host tests drive the agent with a scripted stream that never
 * calls tools, so the stub only needs to exist — but it is a real
 * implementation, not a thrower, so tool-calling tests can grow on it.
 */

import path from "node:path";
import type {
  ExecutionEnv,
  ExecutionError,
  FileInfo,
  Result,
  ShellExecOptions,
} from "@earendil-works/pi-agent-core";
import { FileError, err, ok } from "@earendil-works/pi-agent-core";

const notFound = (filePath: string) =>
  new FileError("not_found", `no such file or directory: ${filePath}`, filePath);

const norm = (filePath: string, cwd: string) =>
  path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);

const isText = (content: string | Uint8Array): content is string => typeof content === "string";

// Pin the error type: `ok`/`err` leave `TError` unbound at inference, which
// would widen every `Result` to `unknown` and break the `ExecutionEnv` seam.
const okResult = <TValue>(value: TValue): Result<TValue, FileError> => ok(value);
const okVoid = (): Result<void, FileError> => ({ ok: true, value: undefined });
const errResult = (error: FileError): Result<never, FileError> => err(error);

export class StubEnv implements ExecutionEnv {
  readonly cwd: string;
  private readonly files = new Map<string, Uint8Array>();
  private readonly dirs = new Set<string>();
  /** Every command executed, in order. */
  readonly commands: { command: string; cwd: string }[] = [];
  /** Canned bash output; empty string by default. */
  bashStdout = "";

  constructor(cwd: string) {
    this.cwd = cwd;
    this.dirs.add(cwd);
  }

  writeFileSync(filePath: string, content: string | Uint8Array) {
    const target = norm(filePath, this.cwd);
    this.files.set(target, isText(content) ? new TextEncoder().encode(content) : content);
  }

  private fileInfoFor(filePath: string) {
    const target = norm(filePath, this.cwd);
    const value = this.files.get(target);
    return value === undefined
      ? undefined
      : {
          kind: "file" as const,
          mtimeMs: 0,
          name: path.basename(target),
          path: target,
          size: value.byteLength,
        };
  }

  async absolutePath(filePath: string) {
    return await Promise.resolve(okResult(norm(filePath, this.cwd)));
  }

  async joinPath(parts: string[]) {
    void this.cwd;
    return await Promise.resolve(okResult(path.join(...parts)));
  }

  async readTextFile(filePath: string) {
    const info = this.fileInfoFor(filePath);
    if (info === undefined) {
      return errResult(notFound(filePath));
    }
    return await Promise.resolve(okResult(new TextDecoder().decode(this.files.get(info.path))));
  }

  async readTextLines(
    filePath: string,
    options?: { maxLines?: number; abortSignal?: AbortSignal },
  ) {
    const content: Result<string, FileError> = await this.readTextFile(filePath);
    if (!content.ok) {
      return content;
    }
    const lines = content.value.split("\n");
    return await Promise.resolve(
      okResult(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines)),
    );
  }

  async readBinaryFile(filePath: string) {
    const info = this.fileInfoFor(filePath);
    if (info === undefined) {
      return errResult(notFound(filePath));
    }
    return await Promise.resolve(okResult(this.files.get(info.path) ?? new Uint8Array()));
  }

  async writeFile(filePath: string, content: string | Uint8Array) {
    this.writeFileSync(filePath, content);
    return await Promise.resolve(okVoid());
  }

  async appendFile(filePath: string, content: string | Uint8Array) {
    const target = norm(filePath, this.cwd);
    const existing = this.files.get(target);
    const bytes = isText(content) ? new TextEncoder().encode(content) : content;
    const next = existing === undefined ? bytes : new Uint8Array([...existing, ...bytes]);
    this.files.set(target, next);
    return await Promise.resolve(okVoid());
  }

  async renameFile(sourcePath: string, destinationPath: string) {
    const source = norm(sourcePath, this.cwd);
    const value = this.files.get(source);
    if (value === undefined) {
      return errResult(notFound(sourcePath));
    }
    this.files.delete(source);
    this.files.set(norm(destinationPath, this.cwd), value);
    return await Promise.resolve(okVoid());
  }

  async fileInfo(filePath: string) {
    const info = this.fileInfoFor(filePath);
    return await Promise.resolve(
      info === undefined ? errResult(notFound(filePath)) : okResult(info),
    );
  }

  async listDir(filePath: string) {
    const target = norm(filePath, this.cwd);
    const entries: FileInfo[] = [];
    for (const entryPath of this.files.keys()) {
      if (entryPath.startsWith(`${target}/`)) {
        const rest = entryPath.slice(target.length + 1);
        if (!rest.includes("/")) {
          const info = this.fileInfoFor(entryPath);
          if (info !== undefined) {
            entries.push(info);
          }
        }
      }
    }
    for (const dir of this.dirs) {
      if (dir !== target && dir.startsWith(`${target}/`)) {
        const rest = dir.slice(target.length + 1);
        if (!rest.includes("/")) {
          entries.push({ kind: "directory", mtimeMs: 0, name: rest, path: dir, size: 0 });
        }
      }
    }
    return await Promise.resolve(okResult(entries));
  }

  async canonicalPath(filePath: string) {
    return await Promise.resolve(okResult(norm(filePath, this.cwd)));
  }

  async exists(filePath: string) {
    const target = norm(filePath, this.cwd);
    return await Promise.resolve(okResult(this.files.has(target) || this.dirs.has(target)));
  }

  async createDir(filePath: string, options?: { recursive?: boolean }) {
    const target = norm(filePath, this.cwd);
    this.dirs.add(target);
    if (options?.recursive !== false) {
      let current = path.dirname(target);
      while (current.startsWith(this.cwd) && current !== this.cwd) {
        this.dirs.add(current);
        current = path.dirname(current);
      }
    }
    return await Promise.resolve(okVoid());
  }

  async remove(filePath: string, options?: { recursive?: boolean; force?: boolean }) {
    const target = norm(filePath, this.cwd);
    let removed = this.files.delete(target);
    if (options?.recursive === true) {
      for (const key of this.files.keys()) {
        if (key.startsWith(`${target}/`)) {
          this.files.delete(key);
          removed = true;
        }
      }
      for (const dir of this.dirs) {
        if (dir === target || dir.startsWith(`${target}/`)) {
          this.dirs.delete(dir);
          removed = true;
        }
      }
    } else if (this.dirs.delete(target)) {
      removed = true;
    }
    return await Promise.resolve(
      removed || options?.force === true ? okVoid() : errResult(notFound(filePath)),
    );
  }

  async createTempDir(prefix?: string) {
    const filePath = `${this.cwd}/${prefix ?? "tmp-"}`;
    this.dirs.add(filePath);
    return await Promise.resolve(okResult(filePath));
  }

  async createTempFile(options?: { prefix?: string; suffix?: string }) {
    const filePath = `${this.cwd}/${options?.prefix ?? ""}${Math.random().toString(36).slice(2)}${options?.suffix ?? ""}`;
    this.files.set(filePath, new Uint8Array());
    return await Promise.resolve(okResult(filePath));
  }

  async cleanup() {
    void this.cwd;
    await Promise.resolve();
  }

  async exec(command: string, options?: ShellExecOptions) {
    this.commands.push({ command, cwd: options?.cwd ?? this.cwd });
    return await Promise.resolve(
      ok<{ exitCode: number; stderr: string; stdout: string }, ExecutionError>({
        exitCode: 0,
        stderr: "",
        stdout: this.bashStdout,
      }),
    );
  }
}
