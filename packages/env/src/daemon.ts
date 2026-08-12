/**
 * The env daemon (daemon.ts): the hands process of ADR 0003 — one binary,
 * one protocol (protocol.ts), the pi tool surface (`read`/`bash`/`edit`/
 * `write`) over WebSocket JSONL.
 *
 * The daemon is a token-gated WebSocket server. Each connection opens with
 * `env_hello {token, version, cwd?}` — the cwd fixes the workspace the
 * connection's tools operate on (a worker connects once per thread with
 * the thread's workspace). Requests are served by a `LocalEnv` bound to
 * that workspace: pi's promise contract at the boundary, `Effect.result`
 * captured failures, no try/catch.
 *
 * The same connection handler serves two transports:
 *
 * - the local WebSocket server (`makeEnvDaemon`) — behind the Box host's
 *   `host --private` URL, or the loopback for direct connections
 * - the outbound relay socket (`makeEnvRelayClient` in relay.ts) — the
 *   user's machine has no open ports, so the daemon dials the hub and the
 *   hub pipes a worker's connection onto this socket
 *
 * So the protocol, the auth, and the tool engine are shared; only the
 * transport differs. Both transports are exercised by tests over real
 * sockets.
 */

import { WebSocketServer, type WebSocket } from "ws";
import { Effect, FileSystem, Result, Schema, Scope } from "effect";
import type {
  ExecutionEnv,
  ExecutionError,
  FileError,
  FileInfo,
  Result as PiResult,
} from "@earendil-works/pi-agent-core";

import { serializeFrame, decodeFrame, parseFrame } from "@saku/wire";
import {
  ENV_VERSION,
  EnvAbort,
  EnvErrorFrame,
  EnvHello,
  EnvHelloOk,
  EnvOp,
  EnvRequest,
  EnvResponseError,
  EnvResponseOk,
  EnvStream,
  type EnvError,
  type EnvOp as EnvOpType,
} from "./protocol.ts";
import { LocalEnv } from "./local-env.ts";

/** The failures a connection can produce; everything maps to an EnvError. */
const serializePiError = (error: FileError | ExecutionError): EnvError => ({
  kind: error.code,
  message: error.message,
  ...("path" in error && error.path !== undefined ? { path: error.path } : {}),
});

const DECODE_FIRST = Schema.decodeUnknownSync(EnvHello);
const DECODE_REQUEST = Schema.decodeUnknownSync(EnvRequest);
const DECODE_ABORT = Schema.decodeUnknownSync(EnvAbort);
const DECODE_OP = Schema.decodeUnknownSync(EnvOp);

export interface EnvDaemonOptions {
  readonly token: string;
  /** Listen host; default loopback (the Box's `host` proxy fronts it). */
  readonly host?: string;
  /** 0 = random free port (the URL is returned). */
  readonly port?: number;
  /** Default workspace for connections that omit `cwd` in their hello. */
  readonly cwd?: string;
  readonly fs: FileSystem.FileSystem;
  readonly log?: (message: string) => void;
}

export interface EnvDaemonShape {
  /** The ws:// URL the daemon listens on. */
  readonly url: string;
  /** Stop the daemon: drop connections, close the server. */
  readonly close: () => Effect.Effect<void, never>;
}

/** The per-connection context the daemon and the relay client share. */
export interface EnvConnectionContext {
  readonly token: string;
  readonly cwd: string;
  readonly fs: FileSystem.FileSystem;
  readonly log: (message: string) => void;
}

const decodeOp = (value: unknown): Result.Result<EnvOpType, string> =>
  Result.try(() => DECODE_OP(value)).pipe(Result.mapError(String));

/**
 * One env operation, executed against the connection's LocalEnv. `exec`
 * streams stdout/stderr through `send` and registers its aborter keyed by
 * the request id (an `env_abort` frame kills the process).
 */
const runOp = (
  env: ExecutionEnv,
  id: string,
  op: EnvOpType,
  ctx: {
    readonly cwd: string;
    readonly pid: number;
    readonly aborters: Map<string, () => void>;
    readonly send: (frame: unknown) => void;
  },
): Promise<{ ok: true; payload: unknown } | { ok: false; error: EnvError }> => {
  const fail = (error: FileError | ExecutionError): { ok: false; error: EnvError } => ({
    ok: false,
    error: serializePiError(error),
  });
  const run = <T, E extends FileError | ExecutionError>(
    promise: Promise<PiResult<T, E>>,
  ): Promise<{ ok: true; payload: T } | { ok: false; error: EnvError }> =>
    promise.then((outcome) =>
      outcome.ok ? { ok: true, payload: outcome.value } : fail(outcome.error),
    );

  switch (op._tag) {
    case "health":
      return Promise.resolve({
        ok: true,
        payload: { cwd: ctx.cwd, pid: ctx.pid, version: ENV_VERSION },
      });
    case "absolute_path":
      return run<string, FileError>(env.absolutePath(op.path));
    case "join_path":
      return run<string, FileError>(env.joinPath([...op.parts]));
    case "read_text_file":
      return run<string, FileError>(env.readTextFile(op.path));
    case "read_text_lines":
      return run<string[], FileError>(
        env.readTextLines(
          op.path,
          op.maxLines === undefined ? undefined : { maxLines: op.maxLines },
        ),
      );
    case "read_binary_file":
      return run<string, FileError>(
        env.readBinaryFile(op.path).then((outcome) =>
          outcome.ok
            ? {
                ok: true as const,
                value: Buffer.from(outcome.value).toString("base64"),
              }
            : { ok: false as const, error: outcome.error },
        ),
      );
    case "write_file": {
      const content = op.encoding === "base64" ? Buffer.from(op.content, "base64") : op.content;
      return run<void, FileError>(env.writeFile(op.path, content));
    }
    case "append_file": {
      const content = op.encoding === "base64" ? Buffer.from(op.content, "base64") : op.content;
      return run<void, FileError>(env.appendFile(op.path, content));
    }
    case "rename_file":
      return run<void, FileError>(env.renameFile(op.sourcePath, op.destinationPath));
    case "file_info":
      return run<FileInfo, FileError>(env.fileInfo(op.path));
    case "list_dir":
      return run<FileInfo[], FileError>(env.listDir(op.path));
    case "canonical_path":
      return run<string, FileError>(env.canonicalPath(op.path));
    case "exists":
      return run<boolean, FileError>(env.exists(op.path));
    case "create_dir":
      return run<void, FileError>(env.createDir(op.path, { recursive: op.recursive ?? true }));
    case "remove":
      return run<void, FileError>(env.remove(op.path, { recursive: op.recursive ?? false, force: op.force ?? false }));
    case "create_temp_dir":
      return run<string, FileError>(env.createTempDir(op.prefix));
    case "create_temp_file":
      return run<string, FileError>(env.createTempFile(op.prefix === undefined ? {} : { prefix: op.prefix }));
    case "exec": {
      const controller = new AbortController();
      ctx.aborters.set(id, () => controller.abort());
      return run<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>(
        env.exec(op.command, {
          ...(op.cwd === undefined ? {} : { cwd: op.cwd }),
          ...(op.env === undefined ? {} : { env: op.env }),
          ...(op.timeout === undefined ? {} : { timeout: op.timeout }),
          ...(op.inheritEnv === undefined ? {} : { inheritEnv: op.inheritEnv }),
          abortSignal: controller.signal,
          onStdout: (text) => ctx.send(EnvStream.make({ id, kind: "stdout", text })),
          onStderr: (text) => ctx.send(EnvStream.make({ id, kind: "stderr", text })),
        }),
      );
    }
    default: {
      const exhaustive: never = op;
      return Promise.resolve({
        ok: false,
        error: { kind: "unknown", message: `unknown op: ${String(exhaustive)}` },
      });
    }
  }
};

/**
 * Serve one env connection: hello handshake, then request/response with
 * streamed exec output. Shared by the local server and the relay socket.
 * Total: every failure is a frame + close, never a thrown effect.
 * Resolves when the socket closes.
 */
export const handleEnvConnection = (
  socket: WebSocket,
  ctx: EnvConnectionContext,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const aborters = new Map<string, () => void>();
    const send = (frame: unknown): void => {
      Result.try(() => socket.send(serializeFrame(frame)));
    };
    const drop = (message: string): void => {
      send(EnvErrorFrame.make({ message }));
      socket.close();
    };

    // -- hello: the first frame must be env_hello ----------------------------
    const helloOutcome = yield* Effect.callback<Result.Result<EnvHello, string>>((resume) => {
      let done = false;
      const finish = (outcome: Result.Result<EnvHello, string>): void => {
        if (done) return;
        done = true;
        socket.off("message", onMessage);
        socket.off("close", onClose);
        resume(Effect.succeed(outcome));
      };
      const onMessage = (data: unknown): void => {
        const parsed = Result.try(() => parseFrame(decodeFrame(data)));
        if (Result.isFailure(parsed)) return; // keep waiting for a frame
        if (typeof parsed.success !== "object" || parsed.success === null) return;
        const frame = parsed.success as { _tag?: string };
        // The hub's rejection of a relay registration arrives as env_error.
        if (frame._tag === "env_error") {
          const message = (parsed.success as { message?: string }).message;
          finish(Result.fail(message ?? "env_error"));
          return;
        }
        const decoded = Result.try(() => DECODE_FIRST(parsed.success));
        if (Result.isFailure(decoded)) {
          finish(Result.fail("expected env_hello"));
          return;
        }
        finish(Result.succeed(decoded.success));
      };
      const onClose = (): void => {
        finish(Result.fail("connection closed before env_hello"));
      };
      socket.on("message", onMessage);
      socket.once("close", onClose);
      return Effect.sync(() => {
        socket.off("message", onMessage);
        socket.off("close", onClose);
      });
    });
    if (Result.isFailure(helloOutcome)) {
      ctx.log(helloOutcome.failure);
      drop(helloOutcome.failure);
      return;
    }
    const hello = helloOutcome.success;
    if (hello.version !== ENV_VERSION) {
      drop(`version mismatch: expected ${ENV_VERSION}`);
      return;
    }
    if (hello.token !== ctx.token) {
      drop("invalid token");
      return;
    }
    const cwd = hello.cwd ?? ctx.cwd;
    const env = new LocalEnv(cwd, ctx.fs);
    send(EnvHelloOk.make({ pid: process.pid, version: ENV_VERSION, cwd }));

    // -- requests ------------------------------------------------------------
    const onMessage = (data: unknown): void => {
      const parsed = Result.try(() => parseFrame(decodeFrame(data)));
      if (Result.isFailure(parsed) || parsed.success === undefined) return;
      if (typeof parsed.success !== "object" || parsed.success === null) return;
      const frame = parsed.success as { _tag?: string };
      if (frame._tag === "env_abort") {
        const decoded = Result.try(() => DECODE_ABORT(parsed.success));
        if (Result.isFailure(decoded)) return;
        aborters.get(decoded.success.id)?.();
        return;
      }
      if (frame._tag !== "env_request") return;
      const request = Result.try(() => DECODE_REQUEST(parsed.success));
      if (Result.isFailure(request)) {
        send(
          EnvResponseError.make({
            id: "(decode)",
            ok: false,
            error: { kind: "invalid", message: "undecodable env_request" },
          }),
        );
        return;
      }
      const id = request.success.id;
      const op = decodeOp(request.success.op);
      if (Result.isFailure(op)) {
        send(
          EnvResponseError.make({
            id,
            ok: false,
            error: { kind: "invalid", message: op.failure },
          }),
        );
        return;
      }
      void Promise.resolve(runOp(env, id, op.success, { cwd, pid: process.pid, aborters, send }))
        .then((outcome) => {
          if (outcome.ok) {
            send(EnvResponseOk.make({ id, ok: true, payload: outcome.payload }));
          } else {
            send(EnvResponseError.make({ id, ok: false, error: outcome.error }));
          }
        })
        .catch((error: unknown) => {
          send(
            EnvResponseError.make({
              id,
              ok: false,
              error: { kind: "unknown", message: String(error) },
            }),
          );
        })
        .finally(() => aborters.delete(id));
    };
    socket.on("message", onMessage);

    yield* Effect.callback<void>((resume) => {
      const onClose = (): void => {
        resume(Effect.void);
      };
      socket.once("close", onClose);
      return Effect.sync(() => socket.off("close", onClose));
    });
    // The connection is gone; kill whatever is still running.
    for (const abort of aborters.values()) abort();
  });

/** Build the daemon: listen, then serve connections until close. */
export const makeEnvDaemon = (
  options: EnvDaemonOptions,
): Effect.Effect<EnvDaemonShape, Error, Scope.Scope> =>
  Effect.gen(function* () {
    const { token, fs } = options;
    const log = options.log ?? (() => {});
    const ctx: EnvConnectionContext = {
      token,
      cwd: options.cwd ?? process.cwd(),
      fs,
      log,
    };
    const server = yield* Effect.callback<WebSocketServer, Error>((resume) => {
      const server = new WebSocketServer({
        host: options.host ?? "127.0.0.1",
        port: options.port ?? 0,
      });
      server.on("connection", (socket) => {
        void Effect.runFork(Effect.scoped(handleEnvConnection(socket, ctx)));
      });
      server.on("error", (error) => {
        log(`server error: ${error.message}`);
        resume(Effect.fail(error));
      });
      server.on("listening", () => resume(Effect.succeed(server)));
      return Effect.sync(() => {
        server.close();
      });
    });
    const address = server.address();
    const url =
      address !== null && typeof address !== "string"
        ? `ws://${address.address}:${address.port}`
        : "";
    const close = (): Effect.Effect<void, never> =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
        return Effect.void;
      });
    return { url, close };
  });
