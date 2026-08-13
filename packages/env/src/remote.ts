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
 * The socket is an explicit dependency (`socket`): `RemoteEnv` itself
 * runs in a Durable Object (where the socket is a workerd `WebSocket`,
 * see `workerdSocket`/`workerdSocketFactory`) and on node (where it is a
 * `ws` socket, see `nodeSocket`) — both from the unified socket module
 * (socket.ts). The env protocol is the same over both.
 *
 * The op and payload shapes come from one table (protocol.ts): requests
 * are built as `EnvOp` values, response payloads are decoded against
 * `EnvPayloadSchema` at the boundary — no casts of the wire's own
 * formats.
 */

import {
  ENV_VERSION,
  EnvAbort,
  EnvHello,
  EnvHelloOk,
  EnvPayloadSchema,
  EnvRequest,
  EnvResponseError,
  EnvResponseOk,
  EnvStream,
  EnvErrorFrame,
  RelayAttach,
  toPiError,
  type EnvHandle,
  type EnvOp as EnvOpType,
} from "./protocol.ts";
import {
  workerdSocket,
  workerdSocketFactory,
  type SocketLike,
  type WorkerdWebSocketLike,
} from "./socket.ts";

export {
  workerdSocket,
  workerdSocketFactory,
  type SocketLike,
  type WorkerdWebSocketLike,
} from "./socket.ts";
export { EnvHandle } from "./protocol.ts";
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
import { Option, Schema } from "effect";
import { decodeFrame, parseFrame, serializeFrame } from "@saku/wire";

/**
 * A connection-level failure of the env protocol (connect/hello), tagged
 * so callers can distinguish a rejected hello from a timeout or a socket
 * failure instead of matching message text.
 */
export class EnvConnectionError extends Schema.TaggedError<EnvConnectionError>()(
  "EnvConnectionError",
  {
    kind: Schema.Literals([
      "already_connected",
      "socket_error",
      "closed_before_hello",
      "hello_timeout",
      "rejected",
    ]),
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

/** An `env_response` frame, decoded at the socket boundary (ok/error). */
const EnvResponse = Schema.Union([EnvResponseOk, EnvResponseError]);
const DECODE_HELLO_OK = Schema.decodeUnknownOption(EnvHelloOk);
const DECODE_ERROR_FRAME = Schema.decodeUnknownOption(EnvErrorFrame);
const DECODE_STREAM = Schema.decodeUnknownOption(EnvStream);
const DECODE_RESPONSE = Schema.decodeUnknownOption(EnvResponse);

export interface RemoteEnvOptions {
  /** The daemon's endpoint: direct (host URL) or the hub's relay server. */
  readonly url: string;
  /** The env protocol token, presented in `env_hello`. */
  readonly token: string;
  /** The socket factory: `nodeSocket` on node, `workerdSocketFactory` in DOs. */
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

/** The node process object, when RemoteEnv runs on node (a DO has none). */
const nodeProcess = globalThis as { process?: { cwd?: () => string } };

/** pi's Result is structural ({ok, value}|{ok:false, error}); a narrow guard. */
const isSuccess = <T, E>(
  outcome: PiResult<T, E>,
): outcome is Extract<PiResult<T, E>, { readonly ok: true }> => outcome.ok;

/** The FileError boundary: after `isSuccess`, the failure is a FileError. */
const asFile = <T>(outcome: PiResult<T, FileError | ExecutionError>): PiResult<T, FileError> =>
  outcome as PiResult<T, FileError>;

/** The op's response payload type, read from the payload table (protocol.ts). */
type PayloadOf<O extends EnvOpType> = (typeof EnvPayloadSchema)[O["_tag"]]["Type"];

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
    | { resolve: (hello: EnvHelloOk) => void; reject: (error: EnvConnectionError) => void }
    | undefined;
  private onceHelloTimer: NodeJS.Timeout | undefined;

  constructor(options: RemoteEnvOptions) {
    this.url = options.url;
    this.token = options.token;
    this.cwd = options.cwd ?? nodeProcess.process?.cwd?.() ?? "/";
    this.socketFactory = options.socket;
    this.relay = options.relay;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.log = options.log ?? (() => {});
  }

  /** Open the connection, attach through the relay if configured, hello. */
  connect(): Promise<EnvHelloOk> {
    if (this.socket !== null) {
      return Promise.reject(
        new EnvConnectionError({ kind: "already_connected", message: "already connected" }),
      );
    }
    return new Promise<EnvHelloOk>((resolve, reject) => {
      let settled = false;
      const fail = (error: EnvConnectionError): void => {
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
        fail(
          new EnvConnectionError({
            kind: "socket_error",
            message: `env connection failed: ${message}`,
            cause: error,
          }),
        );
      });
      socket.on("close", () => {
        const wasConnected = this.connected;
        this.socket = null;
        this.failAll(CONNECTION_LOST);
        if (!wasConnected) {
          fail(
            new EnvConnectionError({
              kind: "closed_before_hello",
              message: "env connection closed before hello",
            }),
          );
        }
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
        fail(new EnvConnectionError({ kind: "hello_timeout", message: "env hello timed out" }));
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
      const hello = DECODE_HELLO_OK(parsed);
      if (Option.isSome(hello)) this.onceHello?.resolve(hello.value);
      return;
    }
    if (frame._tag === "env_error") {
      const error = DECODE_ERROR_FRAME(parsed);
      if (Option.isSome(error)) {
        this.onceHello?.reject(
          new EnvConnectionError({ kind: "rejected", message: error.value.message }),
        );
      }
      return;
    }
    if (frame._tag === "env_stream") {
      const stream = DECODE_STREAM(parsed);
      if (Option.isSome(stream)) {
        this.pending.get(stream.value.id)?.onStream?.(stream.value.kind, stream.value.text);
      }
      return;
    }
    if (frame._tag === "env_response") {
      const response = DECODE_RESPONSE(parsed);
      if (Option.isNone(response)) return;
      const pending = this.pending.get(response.value.id);
      if (pending === undefined) return;
      this.pending.delete(response.value.id);
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      if (response.value.ok) {
        pending.resolve({ ok: true, payload: response.value.payload });
      } else {
        pending.resolve({ ok: false, error: response.value.error });
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
          this.socket?.send(serializeFrame(EnvAbort.make({ id })));
        }, effective);
      }
      const onAbort = (): void => {
        this.socket?.send(serializeFrame(EnvAbort.make({ id })));
      };
      options.abortSignal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, pending);
      this.socket?.send(serializeFrame(EnvRequest.make({ id, op })));
    });
  }

  /**
   * The request→pi-Result boundary: the response payload is decoded
   * against the op's entry in the payload table (protocol.ts), and
   * failures become pi's error classes.
   */
  private async op<O extends EnvOpType>(
    op: O,
    options: {
      onStream?: (kind: "stdout" | "stderr", text: string) => void;
      timeoutMs?: number;
      abortSignal?: AbortSignal;
    } = {},
  ): Promise<PiResult<PayloadOf<O>, FileError | ExecutionError>> {
    const outcome = await this.request(op, options);
    if (!outcome.ok) {
      return err(toPiError(outcome.error));
    }
    // TS widens `EnvPayloadSchema[op._tag]` to the table's union for a
    // generic tag; the schema the runtime decode uses is exactly the
    // op's entry, so this is the only cast — the decode below is the
    // boundary check that makes it safe.
    const schema = EnvPayloadSchema[op._tag] as (typeof EnvPayloadSchema)[O["_tag"]];
    const payload = Schema.decodeUnknownOption(schema)(outcome.payload);
    if (Option.isNone(payload)) {
      return err(toPiError({ kind: "invalid", message: `undecodable ${op._tag} payload` }));
    }
    return ok(payload.value);
  }

  /** Close the connection; in-flight requests fail with "env connection closed". */
  close(): void {
    this.socket?.close();
    this.socket = null;
    this.connected = false;
  }

  // -- ExecutionEnv ---------------------------------------------------------

  /** File-channel ops: failures are FileErrors, the payload is the raw value. */
  private fileOp<O extends EnvOpType>(op: O): Promise<PiResult<PayloadOf<O>, FileError>> {
    return this.op(op) as Promise<PiResult<PayloadOf<O>, FileError>>;
  }

  async absolutePath(path: string): Promise<PiResult<string, FileError>> {
    return this.fileOp({ _tag: "absolute_path", path });
  }

  async joinPath(parts: string[]): Promise<PiResult<string, FileError>> {
    return this.fileOp({ _tag: "join_path", parts });
  }

  async readTextFile(path: string): Promise<PiResult<string, FileError>> {
    return this.fileOp({ _tag: "read_text_file", path });
  }

  async readTextLines(
    path: string,
    options?: { maxLines?: number; abortSignal?: AbortSignal },
  ): Promise<PiResult<string[], FileError>> {
    return this.fileOp({
      _tag: "read_text_lines",
      path,
      ...(options?.maxLines === undefined ? {} : { maxLines: options.maxLines }),
    });
  }

  async readBinaryFile(
    path: string,
    _signal?: AbortSignal,
  ): Promise<PiResult<Uint8Array, FileError>> {
    const outcome = await this.fileOp({ _tag: "read_binary_file", path });
    return isSuccess(outcome) ? ok(base64ToBytes(outcome.value)) : asFile(outcome);
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<PiResult<void, FileError>> {
    const binary = typeof content !== "string";
    return this.fileOp({
      _tag: "write_file",
      path,
      content: binary ? bytesToBase64(content) : content,
      ...(binary ? { encoding: "base64" as const } : {}),
    });
  }

  async appendFile(path: string, content: string | Uint8Array): Promise<PiResult<void, FileError>> {
    const binary = typeof content !== "string";
    return this.fileOp({
      _tag: "append_file",
      path,
      content: binary ? bytesToBase64(content) : content,
      ...(binary ? { encoding: "base64" as const } : {}),
    });
  }

  async renameFile(
    sourcePath: string,
    destinationPath: string,
  ): Promise<PiResult<void, FileError>> {
    return this.fileOp({ _tag: "rename_file", sourcePath, destinationPath });
  }

  async fileInfo(path: string): Promise<PiResult<FileInfo, FileError>> {
    return this.fileOp({ _tag: "file_info", path });
  }

  async listDir(path: string, _signal?: AbortSignal): Promise<PiResult<FileInfo[], FileError>> {
    return this.fileOp({ _tag: "list_dir", path });
  }

  async canonicalPath(path: string): Promise<PiResult<string, FileError>> {
    return this.fileOp({ _tag: "canonical_path", path });
  }

  async exists(path: string): Promise<PiResult<boolean, FileError>> {
    return this.fileOp({ _tag: "exists", path });
  }

  async createDir(
    path: string,
    options?: { recursive?: boolean; abortSignal?: AbortSignal },
  ): Promise<PiResult<void, FileError>> {
    return this.fileOp({
      _tag: "create_dir",
      path,
      ...(options?.recursive === undefined ? {} : { recursive: options.recursive }),
    });
  }

  async remove(
    path: string,
    options?: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal },
  ): Promise<PiResult<void, FileError>> {
    return this.fileOp({
      _tag: "remove",
      path,
      ...(options?.recursive === undefined ? {} : { recursive: options.recursive }),
      ...(options?.force === undefined ? {} : { force: options.force }),
    });
  }

  async createTempDir(prefix = "tmp-"): Promise<PiResult<string, FileError>> {
    return this.fileOp({
      _tag: "create_temp_dir",
      ...(prefix === "tmp-" ? {} : { prefix }),
    });
  }

  async createTempFile(options?: {
    prefix?: string;
    suffix?: string;
  }): Promise<PiResult<string, FileError>> {
    return this.fileOp({
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
    const outcome = await this.op(
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
    const outcome = await this.op({ _tag: "health" });
    return outcome as PiResult<{ cwd: string; pid: number; version: string }, ExecutionError>;
  }
}

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
