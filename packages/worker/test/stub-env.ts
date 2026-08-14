/**
 * Stub env (stub-env.ts): an in-memory `ExecutionEnv` for worker unit tests.
 * Files live in a `Map`; `exec` records the command and answers with canned
 * output. The host tests drive the agent with a scripted stream that never
 * calls tools, so the stub only needs to exist — but it is a real
 * implementation, not a thrower, so tool-calling tests can grow on it.
 */

import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type {
  ExecutionEnv,
  FileInfo,
  Result as PiResult,
  ShellExecOptions,
} from "@earendil-works/pi-agent-core";
import { FileError, err, ok } from "@earendil-works/pi-agent-core";

const notFound = (path: string) =>
  new FileError("not_found", `no such file or directory: ${path}`, path);

const norm = (path: string, cwd: string) => (isAbsolute(path) ? path : resolve(cwd, path));

export class StubEnv implements ExecutionEnv {
  readonly cwd: string;
  private readonly files = new Map<string, Uint8Array>();
  private readonly dirs = new Set<string>();
  /** Every command executed, in order. */
  readonly commands: Array<{ command: string; cwd: string }> = [];
  /** Canned bash output; empty string by default. */
  bashStdout = "";

  constructor(cwd: string) {
    this.cwd = cwd;
    this.dirs.add(cwd);
  }

  writeFileSync(path: string, content: string | Uint8Array) {
    const target = norm(path, this.cwd);
    this.files.set(
      target,
      typeof content === "string" ? new TextEncoder().encode(content) : content,
    );
  }

  private fileInfoFor(path: string) {
    const target = norm(path, this.cwd);
    const value = this.files.get(target);
    if (value === undefined) return undefined;
    return {
      name: basename(target),
      path: target,
      kind: "file",
      size: value.byteLength,
      mtimeMs: 0,
    };
  }

  absolutePath(path: string) {
    return Promise.resolve(ok(norm(path, this.cwd)));
  }

  joinPath(parts: string[]) {
    return Promise.resolve(ok(join(...parts)));
  }

  async readTextFile(path: string) {
    const info = this.fileInfoFor(path);
    if (info === undefined) return err(notFound(path));
    return ok(new TextDecoder().decode(this.files.get(info.path)));
  }

  async readTextLines(
    path: string,
    options?: { maxLines?: number; abortSignal?: AbortSignal },
  ) {
    const content = await this.readTextFile(path);
    if (!content.ok) return content;
    const lines = content.value.split("\n");
    return ok(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines));
  }

  async readBinaryFile(path: string) {
    const info = this.fileInfoFor(path);
    if (info === undefined) return err(notFound(path));
    return ok(this.files.get(info.path) ?? new Uint8Array());
  }

  writeFile(path: string, content: string | Uint8Array) {
    this.writeFileSync(path, content);
    return Promise.resolve(ok(undefined));
  }

  appendFile(path: string, content: string | Uint8Array) {
    const target = norm(path, this.cwd);
    const existing = this.files.get(target);
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const next = existing === undefined ? bytes : new Uint8Array([...existing, ...bytes]);
    this.files.set(target, next);
    return Promise.resolve(ok(undefined));
  }

  renameFile(sourcePath: string, destinationPath: string) {
    const source = norm(sourcePath, this.cwd);
    const value = this.files.get(source);
    if (value === undefined) return Promise.resolve(err(notFound(sourcePath)));
    this.files.delete(source);
    this.files.set(norm(destinationPath, this.cwd), value);
    return Promise.resolve(ok(undefined));
  }

  fileInfo(path: string) {
    const info = this.fileInfoFor(path);
    return Promise.resolve(info === undefined ? err(notFound(path)) : ok(info));
  }

  listDir(path: string) {
    const target = norm(path, this.cwd);
    const entries: FileInfo[] = [];
    for (const filePath of this.files.keys()) {
      if (filePath.startsWith(`${target}/`)) {
        const rest = filePath.slice(target.length + 1);
        if (!rest.includes("/")) {
          entries.push(this.fileInfoFor(filePath)!);
        }
      }
    }
    for (const dir of this.dirs) {
      if (dir !== target && dir.startsWith(`${target}/`)) {
        const rest = dir.slice(target.length + 1);
        if (!rest.includes("/")) {
          entries.push({ name: rest, path: dir, kind: "directory", size: 0, mtimeMs: 0 });
        }
      }
    }
    return Promise.resolve(ok(entries));
  }

  canonicalPath(path: string) {
    return Promise.resolve(ok(norm(path, this.cwd)));
  }

  async exists(path: string) {
    const target = norm(path, this.cwd);
    return ok(this.files.has(target) || this.dirs.has(target));
  }

  createDir(path: string, options?: { recursive?: boolean }) {
    const target = norm(path, this.cwd);
    this.dirs.add(target);
    if (options?.recursive !== false) {
      let current = dirname(target);
      while (current.startsWith(this.cwd) && current !== this.cwd) {
        this.dirs.add(current);
        current = dirname(current);
      }
    }
    return Promise.resolve(ok(undefined));
  }

  async remove(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ) {
    const target = norm(path, this.cwd);
    let removed = this.files.delete(target);
    if (options?.recursive) {
      for (const key of [...this.files.keys()]) {
        if (key.startsWith(`${target}/`)) {
          this.files.delete(key);
          removed = true;
        }
      }
      for (const dir of [...this.dirs]) {
        if (dir === target || dir.startsWith(`${target}/`)) {
          this.dirs.delete(dir);
          removed = true;
        }
      }
    } else if (this.dirs.delete(target)) {
      removed = true;
    }
    return removed || options?.force ? ok(undefined) : err(notFound(path));
  }

  createTempDir(prefix?: string) {
    const path = `${this.cwd}/${prefix ?? "tmp-"}`;
    this.dirs.add(path);
    return Promise.resolve(ok(path));
  }

  createTempFile(options?: {
    prefix?: string;
    suffix?: string;
  }) {
    const path = `${this.cwd}/${options?.prefix ?? ""}${Math.random().toString(36).slice(2)}${options?.suffix ?? ""}`;
    this.files.set(path, new Uint8Array());
    return Promise.resolve(ok(path));
  }

  cleanup() {
    return Promise.resolve();
  }

  exec(
    command: string,
    options?: ShellExecOptions,
  ) {
    this.commands.push({ command, cwd: options?.cwd ?? this.cwd });
    return Promise.resolve(ok({ stdout: this.bashStdout, stderr: "", exitCode: 0 }));
  }
}
