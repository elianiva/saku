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
 * - the local WebSocket server (`EnvDaemon.make`) — behind a provider's
 *   port mapping, or the loopback for direct connections
 * - the outbound relay socket (`EnvRelayClient.make` in relay.ts) — the
 *   user's machine has no open ports, so the daemon dials the hub and the
 *   hub pipes a worker's connection onto this socket
 *
 * So the protocol, the auth, and the tool engine are shared; only the
 * transport differs. Both transports are exercised by tests over real
 * sockets.
 */

import { WebSocketServer } from "ws";
import type { RawData, WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { Context, Effect, Match, Result, Schema } from "effect";
import type { FileSystem } from "effect";
import type {
  ExecutionEnv,
  ExecutionError,
  FileError,
  ShellExecOptions,
} from "@earendil-works/pi-agent-core";

import { decodeFrame, isSocketMessage, parseFrame, serializeFrame } from "@saku/wire";
import type { JsonValue, SocketMessage } from "@saku/wire";
import {
  ENV_VERSION,
  EnvAbort,
  EnvErrorFrame,
  EnvHello,
  EnvHelloOk,
  EnvOp,
  EnvPayloadSchema,
  EnvRequest,
  EnvResponseError,
  EnvResponseOk,
  EnvStream,
} from "./protocol.ts";
import type { EnvError, EnvOp as EnvOpType } from "./protocol.ts";
import { LocalEnv } from "./local-env.ts";

/** The failures a connection can produce; everything maps to an EnvError. */
const serializePiError = (error: FileError | ExecutionError) => {
  if ("path" in error && error.path !== undefined) {
    return { kind: error.code, message: error.message, path: error.path };
  }
  return { kind: error.code, message: error.message };
};

/** Whether a decoded frame is a JSON object carrying an optional `_tag`. */
const isFrame = (
  frame: JsonValue | undefined,
): frame is { readonly _tag?: string; readonly message?: string } =>
  typeof frame === "object" && frame !== null;

/** The connection's close carries no payload. */
const NO_PAYLOAD = undefined;

/** Whether the listening address is a TCP port (loopback never yields a pipe name). */
const isAddressObject = (address: AddressInfo | string | null): address is AddressInfo =>
  address !== null && typeof address !== "string";

const DECODE_FIRST = Schema.decodeUnknownSync(EnvHello);
const DECODE_REQUEST = Schema.decodeUnknownSync(EnvRequest);
const DECODE_ABORT = Schema.decodeUnknownSync(EnvAbort);
const DECODE_OP = Schema.decodeUnknownSync(EnvOp);

export interface EnvDaemonOptions {
  readonly token: string;
  /** Listen host; default loopback (a remote provider may front it). */
  readonly host?: string;
  /** 0 = random free port (the URL is returned). */
  readonly port?: number;
  /** Default workspace for connections that omit `cwd` in their hello. */
  readonly cwd?: string;
  readonly fs: FileSystem.FileSystem;
  readonly log?: (message: string) => Effect.Effect<void>;
}

export interface EnvDaemonApi {
  /** The ws:// URL the daemon listens on. */
  readonly url: string;
  /** Stop the daemon: drop connections, close the server. */
  readonly close: () => Effect.Effect<void>;
}

/** The per-connection context the daemon and the relay client share. */
export interface EnvConnectionContext {
  readonly token: string;
  readonly cwd: string;
  readonly fs: FileSystem.FileSystem;
  readonly log: (message: string) => Effect.Effect<void>;
}

const decodeOp = (value: Schema.Json) =>
  Result.try(() => DECODE_OP(value)).pipe(Result.mapError(String));

/**
 * Encode one op's response payload with the protocol's payload table
 * (protocol.ts) — the daemon's responses are checked against the same
 * table the client decodes with, so a payload that drifts from the
 * contract fails here, at the boundary, instead of at a client's cast.
 */
/** The response payload type of an op, read from the payload table (protocol.ts). */
type OpPayload = (typeof EnvPayloadSchema)[EnvOpType["_tag"]]["Type"];

/** One op's execution outcome: the raw payload, or the wire error. */
type RunOpOutcome =
  | { readonly ok: true; readonly payload: OpPayload }
  | { readonly ok: false; readonly error: EnvError };

/**
 * Encode one op's response payload with the protocol's payload table
 * (protocol.ts) — the daemon's responses are checked against the same
 * table the client decodes with, so a payload that drifts from the
 * contract fails here, at the boundary, instead of at a client's cast.
 */
const encodePayload = (op: EnvOpType, payload: OpPayload) =>
  Schema.encodeUnknownSync(EnvPayloadSchema[op._tag])(payload);

/** createTempFile's forwarded options: only the present fields ride the wire. */
interface TempFileOptions {
  prefix?: string;
  suffix?: string;
}

/**
 * One env operation, executed against the connection's LocalEnv. `exec`
 * streams stdout/stderr through `send` and registers its aborter keyed by
 * the request id (an `env_abort` frame kills the process).
 *
 * The outcome type is annotated: the linter's type inference cannot
 * resolve the `Match.tagsExhaustive` result, so the contract is spelled
 * out for it (tsc infers the same shape).
 */
const runOp = async (
  env: ExecutionEnv,
  id: string,
  op: EnvOpType,
  ctx: {
    readonly aborters: Map<string, () => void>;
    readonly cwd: string;
    readonly pid: number;
    readonly send: (frame: JsonValue) => void;
  },
) => {
  const fail = (error: FileError | ExecutionError) => ({
    error: serializePiError(error),
    ok: false as const,
  });

  return await Match.value(op).pipe(
    Match.tagsExhaustive({
      absolute_path: async ({ path }) => {
        const outcome = await env.absolutePath(path);
        return outcome.ok ? { ok: true as const, payload: outcome.value } : fail(outcome.error);
      },
      append_file: async ({ path, content, encoding }) => {
        const bytes = encoding === "base64" ? Buffer.from(content, "base64") : content;
        const outcome = await env.appendFile(path, bytes);
        return outcome.ok ? { ok: true as const, payload: outcome.value } : fail(outcome.error);
      },
      canonical_path: async ({ path }) => {
        const outcome = await env.canonicalPath(path);
        return outcome.ok ? { ok: true as const, payload: outcome.value } : fail(outcome.error);
      },
      create_dir: async ({ path, recursive }) => {
        const outcome = await env.createDir(path, { recursive: recursive ?? true });
        return outcome.ok ? { ok: true as const, payload: outcome.value } : fail(outcome.error);
      },
      create_temp_dir: async ({ prefix }) => {
        const outcome = await env.createTempDir(prefix);
        return outcome.ok ? { ok: true as const, payload: outcome.value } : fail(outcome.error);
      },
      create_temp_file: async ({ prefix, suffix }) => {
        const options: TempFileOptions = {};
        if (prefix !== undefined) {
          options.prefix = prefix;
        }
        if (suffix !== undefined) {
          options.suffix = suffix;
        }
        const outcome = await env.createTempFile(options);
        return outcome.ok ? { ok: true as const, payload: outcome.value } : fail(outcome.error);
      },
      exec: async ({ command, cwd, env: opEnv, timeout, inheritEnv }) => {
        const controller = new AbortController();
        ctx.aborters.set(id, () => {
          controller.abort();
        });
        const options: ShellExecOptions = { abortSignal: controller.signal };
        if (cwd !== undefined) {
          options.cwd = cwd;
        }
        if (opEnv !== undefined) {
          options.env = opEnv;
        }
        if (timeout !== undefined) {
          options.timeout = timeout;
        }
        if (inheritEnv !== undefined) {
          options.inheritEnv = inheritEnv;
        }
        options.onStdout = (text) => {
          ctx.send(EnvStream.make({ id, kind: "stdout", text }));
        };
        options.onStderr = (text) => {
          ctx.send(EnvStream.make({ id, kind: "stderr", text }));
        };
        const outcome = await env.exec(command, options);
        return outcome.ok ? { ok: true as const, payload: outcome.value } : fail(outcome.error);
      },
      exists: async ({ path }) => {
        const outcome = await env.exists(path);
        return outcome.ok ? { ok: true as const, payload: outcome.value } : fail(outcome.error);
      },
      file_info: async ({ path }) => {
        const outcome = await env.fileInfo(path);
        return outcome.ok ? { ok: true as const, payload: outcome.value } : fail(outcome.error);
      },
      health: () => ({
        ok: true as const,
        payload: { cwd: ctx.cwd, pid: ctx.pid, version: ENV_VERSION },
      }),
      join_path: async ({ parts }) => {
        const outcome = await env.joinPath([...parts]);
        return outcome.ok ? { ok: true as const, payload: outcome.value } : fail(outcome.error);
      },
      list_dir: async ({ path }) => {
        const outcome = await env.listDir(path);
        return outcome.ok ? { ok: true as const, payload: outcome.value } : fail(outcome.error);
      },
      read_binary_file: async ({ path }) => {
        const outcome = await env.readBinaryFile(path);
        if (!outcome.ok) {
          return fail(outcome.error);
        }
        return { ok: true as const, payload: Buffer.from(outcome.value).toString("base64") };
      },
      read_text_file: async ({ path }) => {
        const outcome = await env.readTextFile(path);
        return outcome.ok ? { ok: true as const, payload: outcome.value } : fail(outcome.error);
      },
      read_text_lines: async ({ path, maxLines }) => {
        const outcome = await env.readTextLines(
          path,
          maxLines === undefined ? undefined : { maxLines },
        );
        return outcome.ok ? { ok: true as const, payload: outcome.value } : fail(outcome.error);
      },
      remove: async ({ path, recursive, force }) => {
        const outcome = await env.remove(path, {
          force: force ?? false,
          recursive: recursive ?? false,
        });
        return outcome.ok ? { ok: true as const, payload: outcome.value } : fail(outcome.error);
      },
      rename_file: async ({ sourcePath, destinationPath }) => {
        const outcome = await env.renameFile(sourcePath, destinationPath);
        return outcome.ok ? { ok: true as const, payload: outcome.value } : fail(outcome.error);
      },
      write_file: async ({ path, content, encoding }) => {
        const bytes = encoding === "base64" ? Buffer.from(content, "base64") : content;
        const outcome = await env.writeFile(path, bytes);
        return outcome.ok ? { ok: true as const, payload: outcome.value } : fail(outcome.error);
      },
    }),
  );
};

/**
 * Serve one env connection: hello handshake, then request/response with
 * streamed exec output. Shared by the local server and the relay socket.
 * Total: every failure is a frame + close, never a thrown effect.
 * Resolves when the socket closes.
 */
export const handleEnvConnection = Effect.fn("handleEnvConnection")(function* (
  socket: WebSocket,
  ctx: EnvConnectionContext,
) {
  const aborters = new Map<string, () => void>();
  const send = (frame: JsonValue) => {
    Result.try(() => {
      socket.send(serializeFrame(frame));
    });
  };
  const drop = (message: string) => {
    send(EnvErrorFrame.make({ message }));
    socket.close();
  };

  // The first frame must be env_hello.
  const helloOutcome = yield* Effect.callback<Result.Result<EnvHello, string>>((resume) => {
    const hello = {
      done: false,
      finish: (outcome: Result.Result<EnvHello, string>) => {
        if (hello.done) {
          return;
        }
        hello.done = true;
        socket.off("message", hello.onRawMessage);
        socket.off("close", hello.onClose);
        resume(Effect.succeed(outcome));
      },
      onClose: () => {
        hello.finish(Result.fail("connection closed before env_hello"));
      },
      onMessage: (data: SocketMessage) => {
        const parsed = Result.try(() => parseFrame(decodeFrame(data)));
        if (Result.isFailure(parsed)) {
          return;
        }
        // Keep waiting for a frame.
        if (!isFrame(parsed.success)) {
          return;
        }
        // The hub's rejection of a relay registration arrives as env_error.
        if (parsed.success._tag === "env_error") {
          hello.finish(Result.fail(parsed.success.message ?? "env_error"));
          return;
        }
        const decoded = Result.try(() => DECODE_FIRST(parsed.success));
        if (Result.isFailure(decoded)) {
          hello.finish(Result.fail("expected env_hello"));
          return;
        }
        hello.finish(Result.succeed(decoded.success));
      },
      onRawMessage: (data: RawData) => {
        if (isSocketMessage(data)) {
          hello.onMessage(data);
        }
      },
    };
    socket.on("message", hello.onRawMessage);
    socket.once("close", hello.onClose);
    return Effect.sync(() => {
      socket.off("message", hello.onRawMessage);
      socket.off("close", hello.onClose);
    });
  });
  if (Result.isFailure(helloOutcome)) {
    yield* ctx.log(helloOutcome.failure);
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
  send(EnvHelloOk.make({ cwd, pid: process.pid, version: ENV_VERSION }));

  const onMessage = async (data: SocketMessage) => {
    const parsed = Result.try(() => parseFrame(decodeFrame(data)));
    if (Result.isFailure(parsed) || parsed.success === undefined) {
      return;
    }
    if (!isFrame(parsed.success)) {
      return;
    }
    if (parsed.success._tag === "env_abort") {
      const decoded = Result.try(() => DECODE_ABORT(parsed.success));
      if (Result.isFailure(decoded)) {
        return;
      }
      aborters.get(decoded.success.id)?.();
      return;
    }
    if (parsed.success._tag !== "env_request") {
      return;
    }
    const request = Result.try(() => DECODE_REQUEST(parsed.success));
    if (Result.isFailure(request)) {
      send(
        EnvResponseError.make({
          error: { kind: "invalid", message: "undecodable env_request" },
          id: "(decode)",
          ok: false,
        }),
      );
      return;
    }
    const { id } = request.success;
    const op = decodeOp(request.success.op);
    if (Result.isFailure(op)) {
      send(
        EnvResponseError.make({ error: { kind: "invalid", message: op.failure }, id, ok: false }),
      );
      return;
    }
    try {
      const outcome = await runOp(env, id, op.success, { aborters, cwd, pid: process.pid, send });
      if (outcome.ok) {
        send(
          EnvResponseOk.make({
            id,
            ok: true,
            payload: encodePayload(op.success, outcome.payload),
          }),
        );
      } else {
        send(EnvResponseError.make({ error: outcome.error, id, ok: false }));
      }
    } catch (error) {
      send(
        EnvResponseError.make({
          error: { kind: "unknown", message: String(error) },
          id,
          ok: false,
        }),
      );
    } finally {
      aborters.delete(id);
    }
  };
  socket.on("message", (data) => {
    if (isSocketMessage(data)) {
      void onMessage(data);
    }
  });

  yield* Effect.callback<undefined>((resume) => {
    const onClose = () => {
      resume(Effect.succeed(NO_PAYLOAD));
    };
    socket.once("close", onClose);
    return Effect.sync(() => {
      socket.off("close", onClose);
    });
  });
  // The connection is gone; kill whatever is still running.
  for (const abort of aborters.values()) {
    abort();
  }
});

/** The env daemon: `EnvDaemon.make(options)` builds the token-gated server. */
export class EnvDaemon extends Context.Service<EnvDaemon, EnvDaemonApi>()("EnvDaemon", {
  make: Effect.fn("EnvDaemon.make")(function* (options: EnvDaemonOptions) {
    const { token, fs } = options;
    const log = options.log ?? (() => Effect.void);
    const ctx: EnvConnectionContext = {
      cwd: options.cwd ?? process.cwd(),
      fs,
      log,
      token,
    };
    const server = yield* Effect.callback<WebSocketServer, Error>((resume) => {
      const wsServer = new WebSocketServer({
        host: options.host ?? "127.0.0.1",
        port: options.port ?? 0,
      });
      wsServer.on("connection", (socket) => {
        void Effect.runFork(Effect.scoped(handleEnvConnection(socket, ctx)));
      });
      wsServer.on("error", (error) => {
        // The socket callback is outside the Effect runtime: fork the log.
        void Effect.runFork(log(`server error: ${error.message}`));
        resume(Effect.fail(error));
      });
      wsServer.on("listening", () => {
        resume(Effect.succeed(wsServer));
      });
      return Effect.sync(() => {
        wsServer.close();
      });
    });
    const address = server.address();
    const url = isAddressObject(address) ? `ws://${address.address}:${address.port}` : "";
    const close = () =>
      Effect.callback<undefined>((resume) => {
        server.close(() => {
          resume(Effect.succeed(NO_PAYLOAD));
        });
        return Effect.void;
      });
    return { close, url };
  }),
}) {}
