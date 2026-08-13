/**
 * RemoteEnv (remote.ts): the worker's `ExecutionEnv` over the env protocol
 * (ADR 0003) — the hands a per-thread worker drives when the env is not
 * pinned in its own process.
 *
 * Implements pi's full `FileSystem & Shell` promise contract on the client
 * side of a WebSocket JSONL connection: each op is one request/response
 * exchange; `exec` streams stdout/stderr frames into the pi callbacks and
 * resolves with the final status. Errors cross as pi's own classes
 * (`FileError`/`ExecutionError`), reconstructed from `{kind, message,
 * path?}` — a remote env fails exactly like a local one.
 *
 * Transport: `url` is either the env daemon's direct endpoint (a Box's
 * `host --private` URL) or the hub's relay server; with `relay`, the
 * client attaches to a registered env (`relay_attach`) before its
 * `env_hello`, and the hub pipes the rest.
 *
 * The socket is an explicit dependency (`socket`): `RemoteEnv` itself is
 * isolate-clean and runs in a Durable Object (where the socket is a
 * workerd `WebSocket`, see `workerdSocket`) and on node (where it is a
 * `ws` socket, see `nodeSocket` in remote-node.ts). The env protocol is
 * the same over both.
 */

import {
  ENV_VERSION,
  EnvHello,
  EnvHelloOk,
  EnvRequest,
  EnvResponseError,
  EnvResponseOk,
  EnvStream,
  RelayAttach,
  toPiError,
  type EnvErrorFrame,
  type EnvHandle,
  type EnvOp as EnvOpType,
} from "./protocol.ts";

export type { EnvHandle } from "./protocol.ts";
import {
  ExecutionError,
  err,
  ok,
  type ExecutionEnv,
  type FileError,
  type FileInfo,
  type Result as PiResult,
  type ShellExecOptions,
} from "@earendil-works/pi-agent-core";
import { decodeFrame, parseFrame, serializeFrame } from "@saku/wire";

/**
 * The socket surface RemoteEnv needs: `on` listeners for the four
 * connection events, `send` for frames, `close` to drop. Both `ws`
 * sockets (node) and workerd `WebSocket`s satisfy it through adapters.
 */
export interface SocketLike {
  readonly send: (data: string) => void;
  readonly close: () => void;
  readonly on: (
    event: "open" | "message" | "error" | "close",
    listener: (data: unknown) => void,
  ) => void;
}

/** The minimal workerd `WebSocket` surface the adapter needs. */
export interface WorkerdWebSocketLike {
  readonly send: (data: string) => void;
  readonly close: () => void;
  readonly addEventListener: (
    event: string,
    listener: (event: { readonly data?: unknown }) => void,
  ) => void;
}

/** Adapt a workerd `WebSocket` to the `SocketLike` surface (DOs, celld). */
export const workerdSocket = (ws: WorkerdWebSocketLike): SocketLike => ({
  send: (data) => ws.send(data),
  close: () => ws.close(),
  on: (event, listener) => {
    if (event === "message") {
      ws.addEventListener("message", (ev) => listener(ev.data));
    } else if (event === "error") {
      ws.addEventListener("error", () => listener(new Error("websocket error")));
    } else if (event === "close") {
      ws.addEventListener("close", () => listener(undefined));
    } else {
      ws.addEventListener("open", () => listener(undefined));
    }
  },
});

/** A workerd socket factory for `RemoteEnv` (the DO's `socket` option). */
export const workerdSocketFactory = (url: string): SocketLike =>
  workerdSocket(new WebSocket(url) as unknown as WorkerdWebSocketLike);

/** Binary ↔ base64 without node's Buffer (workerd has atob/btoa). */
const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
};

const base64ToBytes = (encoded: string): Uint8Array => {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

export interface RemoteEnvOptions {
  /** The daemon's endpoint: direct (host URL) or the hub's relay server. */
  readonly url: string;
  /** The env protocol token, presented in `env_hello`. */
  readonly token: string;
  /** The socket factory: `nodeSocket` on node, `workerdSocket` in DOs. */
  readonly socket: (url: string) => SocketLike;
  /** The workspace the connection's tools operate on (hello cwd). */
  readonly cwd?: string;
  /** Attach through the hub relay to this registered env. */
  readonly relay?: { readonly envId: string; readonly token: string };
  /** Per-request cap; `exec` may override with its own timeout. Default: none. */
  readonly requestTimeoutMs?: number;
  readonly log?: (message: string) => void;
}

interface Pending {
  readonly resolve: (
    outcome: { ok: true; payload: unknown } | { ok: false; error: EnvErrorLike },
  ) => void;
  readonly onStream?: ((kind: "stdout" | "stderr", text: string) => void) | undefined;
  timer?: NodeJS.Timeout | undefined;
}

type EnvErrorLike = {
  readonly kind: string;
  readonly message: string;
  readonly path?: string | undefined;
};

const CONNECTION_LOST = new ExecutionError("unknown", "env connection closed");

/** pi's Result is structural ({ok, value}|{ok:false, error}); a narrow guard. */
const isSuccess = <T, E>(
  outcome: PiResult<T, E>,
): outcome is Extract<PiResult<T, E>, { readonly ok: true }> => outcome.ok;

/** The FileError boundary: after `isSuccess`, the failure is a FileError. */
const asFile = <T>(outcome: PiResult<T, FileError | ExecutionError>): PiResult<T, FileError> =>
  outcome as PiResult<T, FileError>;

/**
 * The worker side of the env protocol. One instance per env connection
 * (one per thread per worker); `connect()` must succeed before ops.
 */
export class RemoteEnv implements ExecutionEnv {
  private readonly url: string;
  private readonly token: string;
  /** The workspace the connection's tools operate on (hello cwd). */
  readonly cwd: string;
  private readonly socketFactory: (url: string) => SocketLike;
  private readonly relay: { readonly envId: string; readonly token: string } | undefined;
  private readonly requestTimeoutMs: number | undefined;
  private readonly log: (message: string) => void;

  private socket: SocketLike | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;
  private onceHello:
    | { resolve: (hello: EnvHelloOk) => void; reject: (error: Error) => void }
    | undefined;
  private onceHelloTimer: NodeJS.Timeout | undefined;

  constructor(options: RemoteEnvOptions) {
    this.url = options.url;
    this.token = options.token;
    this.cwd =
      options.cwd ?? (globalThis as { process?: { cwd?: () => string } }).process?.cwd?.() ?? "/";
    this.socketFactory = options.socket;
    this.relay = options.relay;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.log = options.log ?? (() => {});
  }

  /** Open the connection, attach through the relay if configured, hello. */
  connect(): Promise<EnvHelloOk> {
    if (this.socket !== null) return Promise.reject(new Error("already connected"));
    return new Promise<EnvHelloOk>((resolve, reject) => {
      let settled = false;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        if (this.onceHelloTimer !== undefined) clearTimeout(this.onceHelloTimer);
        this.onceHello = undefined;
        this.socket = null;
        reject(error);
      };
      const socket = this.socketFactory(this.url);
      this.socket = socket;
      socket.on("open", () => {
        if (this.relay !== undefined) {
          socket.send(
            serializeFrame(
              RelayAttach.make({
                envId: this.relay.envId,
                token: this.relay.token,
                version: ENV_VERSION,
              }),
            ),
          );
        }
        socket.send(
          serializeFrame(EnvHello.make({ token: this.token, version: ENV_VERSION, cwd: this.cwd })),
        );
      });
      socket.on("message", (data) => this.onMessage(data));
      socket.on("error", (error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`env connection error: ${message}`);
        fail(new Error(`env connection failed: ${message}`));
      });
      socket.on("close", () => {
        const wasConnected = this.connected;
        this.socket = null;
        this.failAll(CONNECTION_LOST);
        if (!wasConnected) fail(new Error("env connection closed before hello"));
      });
      this.onceHello = {
        resolve: (hello) => {
          if (settled) return;
          settled = true;
          if (this.onceHelloTimer !== undefined) clearTimeout(this.onceHelloTimer);
          this.onceHello = undefined;
          this.connected = true;
          resolve(hello);
        },
        reject: (error) => {
          fail(error);
          this.socket?.close();
        },
      };
      this.onceHelloTimer = setTimeout(() => {
        fail(new Error("env hello timed out"));
        this.socket?.close();
      }, 15_000);
    });
  }

  private connected = false;

  private onMessage(data: unknown): void {
    const parsed = parseFrame(decodeFrame(data));
    if (typeof parsed !== "object" || parsed === null) return;
    const frame = parsed as { _tag?: string };

    if (frame._tag === "env_hello_ok") {
      this.onceHello?.resolve(frame as unknown as EnvHelloOk);
      return;
    }
    if (frame._tag === "env_error") {
      const message = (frame as unknown as EnvErrorFrame).message;
      this.onceHello?.reject(new Error(message));
      return;
    }
    if (frame._tag === "env_stream") {
      const stream = frame as unknown as EnvStream;
      this.pending.get(stream.id)?.onStream?.(stream.kind, stream.text);
      return;
    }
    if (frame._tag === "env_response") {
      const response = frame as unknown as EnvResponseOk | EnvResponseError;
      const pending = this.pending.get(response.id);
      if (pending === undefined) return;
      this.pending.delete(response.id);
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      if (response.ok) {
        pending.resolve({ ok: true, payload: (response as EnvResponseOk).payload });
      } else {
        const error = (response as EnvResponseError).error;
        pending.resolve({ ok: false, error });
      }
    }
  }

  /** Reject every in-flight request; used on close. */
  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: { kind: "unknown", message: error.message } });
    }
    this.pending = new Map();
  }

  /**
   * Send one request and wait for its response. `abortSignal` kills the
   * daemon-side process (exec) with an `env_abort` frame.
   */
  private request(
    op: EnvOpType,
    options: {
      onStream?: (kind: "stdout" | "stderr", text: string) => void;
      timeoutMs?: number;
      abortSignal?: AbortSignal;
    } = {},
  ): Promise<{ ok: true; payload: unknown } | { ok: false; error: EnvErrorLike }> {
    if (this.socket === null || !this.connected) {
      return Promise.resolve({
        ok: false,
        error: { kind: "unknown", message: "env not connected" },
      });
    }
    const id = `${++this.seq}:${crypto.randomUUID().slice(0, 8)}`;
    return new Promise((resolve) => {
      const pending: Pending = { resolve, onStream: options.onStream };
      const effective = options.timeoutMs ?? this.requestTimeoutMs;
      if (effective !== undefined) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          resolve({
            ok: false,
            error: { kind: "timeout", message: `env request timed out after ${effective}ms` },
          });
          this.socket?.send(serializeFrame({ _tag: "env_abort", id }));
        }, effective);
      }
      const onAbort = (): void => {
        this.socket?.send(serializeFrame({ _tag: "env_abort", id }));
      };
      options.abortSignal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, pending);
      this.socket?.send(serializeFrame(EnvRequest.make({ id, op })));
    });
  }

  /** The request→pi-Result boundary: failures become pi's error classes. */
  private async op<T>(
    op: EnvOpType,
    options: {
      onStream?: (kind: "stdout" | "stderr", text: string) => void;
      timeoutMs?: number;
      abortSignal?: AbortSignal;
    } = {},
  ): Promise<PiResult<T, FileError | ExecutionError>> {
    const outcome = await this.request(op, options);
    if (!outcome.ok) {
      return err(toPiError(outcome.error));
    }
    return ok(outcome.payload as T);
  }

  /** Close the connection; in-flight requests fail with "env connection closed". */
  close(): void {
    this.socket?.close();
    this.socket = null;
    this.connected = false;
  }

  // -- ExecutionEnv ---------------------------------------------------------

  /** File-channel ops: failures are FileErrors, the payload is the raw value. */
  private fileOp<T>(op: EnvOpType): Promise<PiResult<T, FileError>> {
    return this.op<T>(op) as Promise<PiResult<T, FileError>>;
  }

  async absolutePath(path: string): Promise<PiResult<string, FileError>> {
    return this.fileOp<string>({ _tag: "absolute_path", path });
  }

  async joinPath(parts: string[]): Promise<PiResult<string, FileError>> {
    return this.fileOp<string>({ _tag: "join_path", parts });
  }

  async readTextFile(path: string): Promise<PiResult<string, FileError>> {
    return this.fileOp<string>({ _tag: "read_text_file", path });
  }

  async readTextLines(
    path: string,
    options?: { maxLines?: number; abortSignal?: AbortSignal },
  ): Promise<PiResult<string[], FileError>> {
    return this.fileOp<string[]>({
      _tag: "read_text_lines",
      path,
      ...(options?.maxLines === undefined ? {} : { maxLines: options.maxLines }),
    });
  }

  async readBinaryFile(
    path: string,
    _signal?: AbortSignal,
  ): Promise<PiResult<Uint8Array, FileError>> {
    const outcome = await this.fileOp<string>({ _tag: "read_binary_file", path });
    return isSuccess(outcome) ? ok(base64ToBytes(outcome.value)) : asFile(outcome);
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<PiResult<void, FileError>> {
    const binary = typeof content !== "string";
    return this.fileOp<void>({
      _tag: "write_file",
      path,
      content: binary ? bytesToBase64(content as Uint8Array) : content,
      ...(binary ? { encoding: "base64" as const } : {}),
    });
  }

  async appendFile(path: string, content: string | Uint8Array): Promise<PiResult<void, FileError>> {
    const binary = typeof content !== "string";
    return this.fileOp<void>({
      _tag: "append_file",
      path,
      content: binary ? bytesToBase64(content as Uint8Array) : content,
      ...(binary ? { encoding: "base64" as const } : {}),
    });
  }

  async renameFile(
    sourcePath: string,
    destinationPath: string,
  ): Promise<PiResult<void, FileError>> {
    return this.fileOp<void>({ _tag: "rename_file", sourcePath, destinationPath });
  }

  async fileInfo(path: string): Promise<PiResult<FileInfo, FileError>> {
    return this.fileOp<FileInfo>({ _tag: "file_info", path });
  }

  async listDir(path: string, _signal?: AbortSignal): Promise<PiResult<FileInfo[], FileError>> {
    return this.fileOp<FileInfo[]>({ _tag: "list_dir", path });
  }

  async canonicalPath(path: string): Promise<PiResult<string, FileError>> {
    return this.fileOp<string>({ _tag: "canonical_path", path });
  }

  async exists(path: string): Promise<PiResult<boolean, FileError>> {
    return this.fileOp<boolean>({ _tag: "exists", path });
  }

  async createDir(
    path: string,
    options?: { recursive?: boolean; abortSignal?: AbortSignal },
  ): Promise<PiResult<void, FileError>> {
    return this.fileOp<void>({
      _tag: "create_dir",
      path,
      ...(options?.recursive === undefined ? {} : { recursive: options.recursive }),
    });
  }

  async remove(
    path: string,
    options?: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal },
  ): Promise<PiResult<void, FileError>> {
    return this.fileOp<void>({
      _tag: "remove",
      path,
      ...(options?.recursive === undefined ? {} : { recursive: options.recursive }),
      ...(options?.force === undefined ? {} : { force: options.force }),
    });
  }

  async createTempDir(prefix = "tmp-"): Promise<PiResult<string, FileError>> {
    return this.fileOp<string>({
      _tag: "create_temp_dir",
      ...(prefix === "tmp-" ? {} : { prefix }),
    });
  }

  async createTempFile(options?: {
    prefix?: string;
    suffix?: string;
  }): Promise<PiResult<string, FileError>> {
    return this.fileOp<string>({
      _tag: "create_temp_file",
      ...(options?.prefix === undefined ? {} : { prefix: options.prefix }),
      ...(options?.suffix === undefined ? {} : { suffix: options.suffix }),
    });
  }

  async cleanup(): Promise<void> {
    // The connection outlives individual ops; close() releases it.
  }

  async exec(
    command: string,
    options?: ShellExecOptions,
  ): Promise<PiResult<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
    const outcome = await this.op<{ stdout: string; stderr: string; exitCode: number }>(
      {
        _tag: "exec",
        command,
        ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options?.env === undefined ? {} : { env: options.env }),
        ...(options?.timeout === undefined ? {} : { timeout: options.timeout }),
        ...(options?.inheritEnv === undefined ? {} : { inheritEnv: options.inheritEnv }),
      },
      {
        onStream: (kind, text) => {
          if (kind === "stdout") options?.onStdout?.(text);
          else options?.onStderr?.(text);
        },
        // The daemon enforces the exec timeout; allow a grace window for the
        // final response to arrive after the process dies.
        ...(options?.timeout === undefined ? {} : { timeoutMs: options.timeout * 1000 + 10_000 }),
        ...(options?.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
      },
    );
    return outcome as PiResult<
      { stdout: string; stderr: string; exitCode: number },
      ExecutionError
    >;
  }

  /** The env's health payload: workspace, pid, protocol version. */
  async health(): Promise<PiResult<{ cwd: string; pid: number; version: string }, ExecutionError>> {
    const outcome = await this.op<{ cwd: string; pid: number; version: string }>({
      _tag: "health",
    });
    return outcome as PiResult<{ cwd: string; pid: number; version: string }, ExecutionError>;
  }
}
