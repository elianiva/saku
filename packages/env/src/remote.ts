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
 * Transport: `url` is either the env daemon's provider endpoint or the
 * hub's relay server; with `relay`, the client attaches to a registered env
 * (`relay_attach`) before its
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

import { ExecutionError, FileError, err, ok } from "@earendil-works/pi-agent-core";
import type {
  ExecutionEnv,
  Result as PiResult,
  ShellExecOptions,
} from "@earendil-works/pi-agent-core";
import { decodeFrame, isSocketMessage, parseFrame, serializeFrame } from "@saku/wire";
import type { JsonValue, SocketMessage } from "@saku/wire";
import { Effect, Option, Schema } from "effect";
import { EnvConnectionError } from "./env-connection-error.ts";
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
} from "./protocol.ts";
import type { EnvOp as EnvOpType } from "./protocol.ts";
import type { SocketLike } from "./socket.ts";

export { EnvConnectionError } from "./env-connection-error.ts";
export {
  workerdSocket,
  workerdSocketFactory,
  type SocketLike,
  type WorkerdWebSocketLike,
} from "./socket.ts";
export { EnvHandle } from "./protocol.ts";

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
  readonly log?: (message: string) => Effect.Effect<void>;
}

interface Pending {
  readonly resolve: (outcome: RequestOutcome) => void;
  readonly onStream?: ((kind: "stdout" | "stderr", text: string) => void) | undefined;
  timer?: NodeJS.Timeout | undefined;
}

interface EnvErrorLike {
  readonly kind: string;
  readonly message: string;
  readonly path?: string | undefined;
}

/** One request's outcome: the response payload, or the wire error. */
type RequestOutcome = { ok: true; payload: unknown } | { ok: false; error: EnvErrorLike };

/** Client-side per-request options: streaming callbacks, timeout, abort. */
interface RequestOptions {
  onStream?: (kind: "stdout" | "stderr", text: string) => void;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

const CONNECTION_LOST = new ExecutionError("unknown", "env connection closed");

// SAFETY: `process` exists only on node; the DO (workerd) global lacks it,
// and the `?? "/"` fallback in the constructor handles that case, so this
// widened shape is exactly the contract the code reads.
const nodeProcess = globalThis as { process?: { cwd?: () => string } };

/** pi's Result is structural ({ok, value}|{ok:false, error}); a narrow guard. */
const isSuccess = <T, E>(
  outcome: PiResult<T, E>,
): outcome is Extract<PiResult<T, E>, { readonly ok: true }> => outcome.ok;

/**
 * Narrow a failure to a FileError (file-op boundary): the daemon paths
 * every file-op failure, so a non-FileError failure is a connection-level
 * collapse folded into an "unknown" FileError below.
 */
const isFileFailure = <T>(
  outcome: PiResult<T, FileError | ExecutionError>,
): outcome is Extract<
  PiResult<T, FileError | ExecutionError>,
  { readonly ok: false; readonly error: FileError }
> => !outcome.ok && outcome.error instanceof FileError;

/** Narrow a failure to an ExecutionError (exec/health boundary). */
const isExecFailure = <T>(
  outcome: PiResult<T, FileError | ExecutionError>,
): outcome is Extract<
  PiResult<T, FileError | ExecutionError>,
  { readonly ok: false; readonly error: ExecutionError }
> => !outcome.ok && outcome.error instanceof ExecutionError;

/**
 * A frame is a JSON object carrying an optional `_tag`; the per-frame
 * payload schemas validate the rest at the decode boundary.
 */
const isFrame = (value: JsonValue | undefined): value is { readonly _tag?: string } =>
  typeof value === "object" && value !== null;

/** True when the payload is text; the wire ops branch on this. */
const isText = (content: string | Uint8Array): content is string => typeof content === "string";

/** The op's response payload type, read from the payload table (protocol.ts). */
type PayloadOf<O extends EnvOpType> = (typeof EnvPayloadSchema)[O["_tag"]]["Type"];

/** Binary ↔ base64 without node's Buffer (workerd has atob/btoa). */
const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  const chunk = 0x80_00;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCodePoint(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
};

const base64ToBytes = (encoded: string) => {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.codePointAt(i) ?? 0;
  }
  return bytes;
};

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
  private readonly log: (message: string) => Effect.Effect<void>;

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
    this.log = options.log ?? (() => Effect.void);
  }

  /** Open the connection, attach through the relay if configured, hello. */
  async connect(): Promise<EnvHelloOk> {
    if (this.socket !== null) {
      throw new EnvConnectionError({ kind: "already_connected", message: "already connected" });
    }
    return await Effect.runPromise(
      Effect.callback<EnvHelloOk, EnvConnectionError>((resume) => {
        let settled = false;
        const fail = (error: EnvConnectionError) => {
          if (settled) {
            return;
          }
          settled = true;
          if (this.onceHelloTimer !== undefined) {
            clearTimeout(this.onceHelloTimer);
          }
          this.onceHello = undefined;
          this.socket = null;
          resume(Effect.fail(error));
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
            serializeFrame(
              EnvHello.make({ cwd: this.cwd, token: this.token, version: ENV_VERSION }),
            ),
          );
        });
        socket.on("message", (data) => {
          if (isSocketMessage(data)) {
            this.onMessage(data);
          }
        });
        socket.on("error", (error) => {
          const message =
            error instanceof Error ? error.message : (JSON.stringify(error) ?? "undefined");
          // The socket callback is outside the Effect runtime: fork the log.
          void Effect.runFork(this.log(`env connection error: ${message}`));
          fail(
            new EnvConnectionError({
              cause: error,
              kind: "socket_error",
              message: `env connection failed: ${message}`,
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
          reject: (error) => {
            fail(error);
            this.socket?.close();
          },
          resolve: (hello) => {
            if (settled) {
              return;
            }
            settled = true;
            if (this.onceHelloTimer !== undefined) {
              clearTimeout(this.onceHelloTimer);
            }
            this.onceHello = undefined;
            this.connected = true;
            resume(Effect.succeed(hello));
          },
        };
        this.onceHelloTimer = setTimeout(() => {
          fail(new EnvConnectionError({ kind: "hello_timeout", message: "env hello timed out" }));
          this.socket?.close();
        }, 15_000);
        return Effect.void;
      }),
    );
  }

  private connected = false;

  private onMessage(data: SocketMessage) {
    const parsed = parseFrame(decodeFrame(data));
    if (!isFrame(parsed)) {
      return;
    }
    if (parsed._tag === "env_hello_ok") {
      const hello = DECODE_HELLO_OK(parsed);
      if (Option.isSome(hello)) {
        this.onceHello?.resolve(hello.value);
      }
      return;
    }
    if (parsed._tag === "env_error") {
      const error = DECODE_ERROR_FRAME(parsed);
      if (Option.isSome(error)) {
        this.onceHello?.reject(
          new EnvConnectionError({ kind: "rejected", message: error.value.message }),
        );
      }
      return;
    }
    if (parsed._tag === "env_stream") {
      const stream = DECODE_STREAM(parsed);
      if (Option.isSome(stream)) {
        this.pending.get(stream.value.id)?.onStream?.(stream.value.kind, stream.value.text);
      }
      return;
    }
    if (parsed._tag === "env_response") {
      const response = DECODE_RESPONSE(parsed);
      if (Option.isNone(response)) {
        return;
      }
      const pending = this.pending.get(response.value.id);
      if (pending === undefined) {
        return;
      }
      this.pending.delete(response.value.id);
      if (pending.timer !== undefined) {
        clearTimeout(pending.timer);
      }
      if (response.value.ok) {
        pending.resolve({ ok: true, payload: response.value.payload });
      } else {
        pending.resolve({ error: response.value.error, ok: false });
      }
    }
  }

  /** Reject every in-flight request; used on close. */
  private failAll(error: Error) {
    for (const pending of this.pending.values()) {
      if (pending.timer !== undefined) {
        clearTimeout(pending.timer);
      }
      pending.resolve({ error: { kind: "unknown", message: error.message }, ok: false });
    }
    this.pending = new Map();
  }

  /**
   * Send one request and wait for its response. `abortSignal` kills the
   * daemon-side process (exec) with an `env_abort` frame.
   */
  private async request(op: EnvOpType, options: RequestOptions = {}): Promise<RequestOutcome> {
    if (this.socket === null || !this.connected) {
      return { error: { kind: "unknown", message: "env not connected" }, ok: false };
    }
    this.seq += 1;
    const id = `${this.seq}:${crypto.randomUUID().slice(0, 8)}`;
    return await Effect.runPromise(
      Effect.callback<RequestOutcome>((resume) => {
        const pending: Pending = {
          onStream: options.onStream,
          resolve: (outcome) => {
            resume(Effect.succeed(outcome));
          },
        };
        const effective = options.timeoutMs ?? this.requestTimeoutMs;
        if (effective !== undefined) {
          const timedOut: RequestOutcome = {
            error: {
              kind: "timeout",
              message: `env request timed out after ${effective}ms`,
            },
            ok: false,
          };
          pending.timer = setTimeout(() => {
            this.pending.delete(id);
            resume(Effect.succeed(timedOut));
            this.socket?.send(serializeFrame(EnvAbort.make({ id })));
          }, effective);
        }
        const onAbort = () => {
          this.socket?.send(serializeFrame(EnvAbort.make({ id })));
        };
        options.abortSignal?.addEventListener("abort", onAbort, { once: true });
        this.pending.set(id, pending);
        this.socket?.send(serializeFrame(EnvRequest.make({ id, op })));
        return Effect.void;
      }),
    );
  }

  /**
   * The request→pi-Result boundary: the response payload is decoded
   * against the op's entry in the payload table (protocol.ts), and
   * failures become pi's error classes.
   */
  private async op<O extends EnvOpType>(
    op: O,
    options: RequestOptions = {},
  ): Promise<PiResult<PayloadOf<O>, FileError | ExecutionError>> {
    const outcome = await this.request(op, options);
    if (!outcome.ok) {
      return err(toPiError(outcome.error));
    }
    const payload = Schema.decodeUnknownOption(EnvPayloadSchema[op._tag])(outcome.payload);
    if (Option.isNone(payload)) {
      return err(toPiError({ kind: "invalid", message: `undecodable ${op._tag} payload` }));
    }
    return ok(payload.value);
  }

  /** Close the connection; in-flight requests fail with "env connection closed". */
  close() {
    this.socket?.close();
    this.socket = null;
    this.connected = false;
  }

  /**
   * File-channel ops: failures are FileErrors, the payload is the raw
   * value. The daemon produces FileErrors for every file-op failure; a
   * pathless connection-level error (disconnect/timeout) is folded into
   * an "unknown" FileError to keep the pi contract.
   */
  private async fileOp<O extends EnvOpType>(op: O): Promise<PiResult<PayloadOf<O>, FileError>> {
    const outcome = await this.op(op);
    if (outcome.ok) {
      return outcome;
    }
    if (isFileFailure(outcome)) {
      return outcome;
    }
    return err(new FileError("unknown", outcome.error.message));
  }

  async absolutePath(path: string) {
    return await this.fileOp({ _tag: "absolute_path", path });
  }

  async joinPath(parts: string[]) {
    return await this.fileOp({ _tag: "join_path", parts });
  }

  async readTextFile(path: string) {
    return await this.fileOp({ _tag: "read_text_file", path });
  }

  async readTextLines(path: string, options?: { maxLines?: number; abortSignal?: AbortSignal }) {
    let op: Extract<EnvOpType, { readonly _tag: "read_text_lines" }> = {
      _tag: "read_text_lines",
      path,
    };
    if (options?.maxLines !== undefined) {
      op = { ...op, maxLines: options.maxLines };
    }
    return await this.fileOp(op);
  }

  async readBinaryFile(
    path: string,
    _signal?: AbortSignal,
  ): Promise<PiResult<Uint8Array, FileError>> {
    const outcome = await this.fileOp({ _tag: "read_binary_file", path });
    return isSuccess(outcome) ? ok(base64ToBytes(outcome.value)) : outcome;
  }

  async writeFile(path: string, content: string | Uint8Array) {
    let op: Extract<EnvOpType, { readonly _tag: "write_file" }> = {
      _tag: "write_file",
      content: isText(content) ? content : bytesToBase64(content),
      path,
    };
    if (!isText(content)) {
      op = { ...op, encoding: "base64" };
    }
    return await this.fileOp(op);
  }

  async appendFile(path: string, content: string | Uint8Array) {
    let op: Extract<EnvOpType, { readonly _tag: "append_file" }> = {
      _tag: "append_file",
      content: isText(content) ? content : bytesToBase64(content),
      path,
    };
    if (!isText(content)) {
      op = { ...op, encoding: "base64" };
    }
    return await this.fileOp(op);
  }

  async renameFile(sourcePath: string, destinationPath: string) {
    return await this.fileOp({ _tag: "rename_file", destinationPath, sourcePath });
  }

  async fileInfo(path: string) {
    return await this.fileOp({ _tag: "file_info", path });
  }

  async listDir(path: string, _signal?: AbortSignal) {
    return await this.fileOp({ _tag: "list_dir", path });
  }

  async canonicalPath(path: string) {
    return await this.fileOp({ _tag: "canonical_path", path });
  }

  async exists(path: string) {
    return await this.fileOp({ _tag: "exists", path });
  }

  async createDir(path: string, options?: { recursive?: boolean; abortSignal?: AbortSignal }) {
    let op: Extract<EnvOpType, { readonly _tag: "create_dir" }> = {
      _tag: "create_dir",
      path,
    };
    if (options?.recursive !== undefined) {
      op = { ...op, recursive: options.recursive };
    }
    return await this.fileOp(op);
  }

  async remove(
    path: string,
    options?: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal },
  ) {
    let op: Extract<EnvOpType, { readonly _tag: "remove" }> = { _tag: "remove", path };
    if (options?.recursive !== undefined) {
      op = { ...op, recursive: options.recursive };
    }
    if (options?.force !== undefined) {
      op = { ...op, force: options.force };
    }
    return await this.fileOp(op);
  }

  async createTempDir(prefix = "tmp-") {
    let op: Extract<EnvOpType, { readonly _tag: "create_temp_dir" }> = {
      _tag: "create_temp_dir",
    };
    if (prefix !== "tmp-") {
      op = { ...op, prefix };
    }
    return await this.fileOp(op);
  }

  async createTempFile(options?: { prefix?: string; suffix?: string }) {
    let op: Extract<EnvOpType, { readonly _tag: "create_temp_file" }> = {
      _tag: "create_temp_file",
    };
    if (options?.prefix !== undefined) {
      op = { ...op, prefix: options.prefix };
    }
    if (options?.suffix !== undefined) {
      op = { ...op, suffix: options.suffix };
    }
    return await this.fileOp(op);
  }

  async cleanup() {
    // The connection outlives individual ops; close() releases it.
    await Promise.resolve(this.connected);
  }

  async exec(
    command: string,
    options?: ShellExecOptions,
  ): Promise<PiResult<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
    let execOp: Extract<EnvOpType, { readonly _tag: "exec" }> = { _tag: "exec", command };
    if (options?.cwd !== undefined) {
      execOp = { ...execOp, cwd: options.cwd };
    }
    if (options?.env !== undefined) {
      execOp = { ...execOp, env: options.env };
    }
    if (options?.timeout !== undefined) {
      execOp = { ...execOp, timeout: options.timeout };
    }
    if (options?.inheritEnv !== undefined) {
      execOp = { ...execOp, inheritEnv: options.inheritEnv };
    }
    const requestOptions: RequestOptions = {
      onStream: (kind, text) => {
        if (kind === "stdout") {
          options?.onStdout?.(text);
        } else {
          options?.onStderr?.(text);
        }
      },
    };
    if (options?.timeout !== undefined) {
      // The daemon enforces the exec timeout; allow a grace window for the
      // final response to arrive after the process dies.
      requestOptions.timeoutMs = options.timeout * 1000 + 10_000;
    }
    if (options?.abortSignal !== undefined) {
      requestOptions.abortSignal = options.abortSignal;
    }
    const outcome = await this.op(execOp, requestOptions);
    if (outcome.ok) {
      return outcome;
    }
    if (isExecFailure(outcome)) {
      return outcome;
    }
    return err(new ExecutionError("unknown", outcome.error.message));
  }

  /** The env's health payload: workspace, pid, protocol version. */
  async health(): Promise<PiResult<{ cwd: string; pid: number; version: string }, ExecutionError>> {
    const outcome = await this.op({ _tag: "health" });
    if (outcome.ok) {
      return outcome;
    }
    if (isExecFailure(outcome)) {
      return outcome;
    }
    return err(new ExecutionError("unknown", outcome.error.message));
  }
}
