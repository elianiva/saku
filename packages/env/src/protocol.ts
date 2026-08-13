/**
 * The env protocol (protocol.ts): the single hands vocabulary of the env
 * daemon (ADR 0003) — one protocol for the local machine and a Box.
 *
 * JSONL frames over WebSocket, the wire's framing habits: one JSON object
 * per line. The connection opens with `env_hello {token, version, cwd?}`
 * (the cwd fixes the workspace the connection's tools operate on); the
 * daemon answers `env_hello_ok {pid, version, cwd}` or `env_error`.
 * Requests are `env_request {id, op}`; responses are `env_response
 * {id, ok, payload}` or `{id, ok: false, error}`; a running `exec` streams
 * `env_stream {id, kind, text}` frames and can be killed with
 * `env_abort {id}`.
 *
 * The ops are exactly pi's `ExecutionEnv` surface (`FileSystem & Shell`),
 * so the daemon can be implemented once (over pi's promise contract) and
 * the worker's remote env can implement `ExecutionEnv` on the client side.
 * Errors cross as `{kind, message, path?}` — FileError when a path is
 * present, ExecutionError otherwise — and are reconstructed as pi's error
 * classes by the client.
 *
 * The relay frames (`relay_hello` / `relay_attach`) are the hub's
 * outbound-relay handshake: the env daemon registers with
 * `relay_hello {envId, token}`, a worker-side `RemoteEnv` attaches with
 * `relay_attach {envId, token}`, and the hub pipes everything else between
 * the two sockets. `env_error` is the connection-level failure frame of
 * both transports (auth, version, unknown env).
 */

import { Schema as S } from "effect";
import {
  ExecutionError,
  FileError,
  type ExecutionErrorCode,
  type FileErrorCode,
} from "@earendil-works/pi-agent-core";

/** The env protocol version; `env_hello` mismatches are rejected. */
export const ENV_VERSION = "1";

/** The kind/name discriminator pi's FileInfo carries. */
export const EnvFileKind = S.Literals(["file", "directory", "symlink"]);

/** pi's FileInfo shape, JSON-safe (LocalEnv's describeEntry output). */
export const EnvFileInfo = S.Struct({
  name: S.String,
  path: S.String,
  kind: EnvFileKind,
  size: S.Number,
  mtimeMs: S.Number,
});
export type EnvFileInfo = S.Schema.Type<typeof EnvFileInfo>;

// -- frames ------------------------------------------------------------------

export const EnvHello = S.TaggedStruct("env_hello", {
  token: S.String,
  version: S.String,
  /** The workspace root the connection's tools operate on. */
  cwd: S.optional(S.String),
});
export type EnvHello = S.Schema.Type<typeof EnvHello>;

export const EnvHelloOk = S.TaggedStruct("env_hello_ok", {
  pid: S.Number,
  version: S.String,
  cwd: S.String,
});
export type EnvHelloOk = S.Schema.Type<typeof EnvHelloOk>;

/** One operation request; the `id` pairs it with its response/streams. */
export const EnvRequest = S.TaggedStruct("env_request", {
  id: S.String,
  op: S.Unknown,
});
export type EnvRequest = S.Schema.Type<typeof EnvRequest>;

/** A streamed chunk of an `exec` (stdout or stderr), before the response. */
export const EnvStream = S.TaggedStruct("env_stream", {
  id: S.String,
  kind: S.Literals(["stdout", "stderr"]),
  text: S.String,
});
export type EnvStream = S.Schema.Type<typeof EnvStream>;

/** Kill the process backing request `id` (exec only). */
export const EnvAbort = S.TaggedStruct("env_abort", { id: S.String });
export type EnvAbort = S.Schema.Type<typeof EnvAbort>;

/** FileError when `path` is present, ExecutionError otherwise. */
export const EnvError = S.Struct({
  kind: S.String,
  message: S.String,
  path: S.optional(S.String),
});
export type EnvError = S.Schema.Type<typeof EnvError>;

export const EnvResponseOk = S.TaggedStruct("env_response", {
  id: S.String,
  ok: S.Literal(true),
  // The wire omits the payload of void ops (JSON drops `undefined`), so
  // the field is optional — the client decodes it per op with
  // `EnvPayloadSchema` below.
  payload: S.optional(S.Unknown),
});
export type EnvResponseOk = S.Schema.Type<typeof EnvResponseOk>;

export const EnvResponseError = S.TaggedStruct("env_response", {
  id: S.String,
  ok: S.Literal(false),
  error: EnvError,
});
export type EnvResponseError = S.Schema.Type<typeof EnvResponseError>;

// -- relay frames ------------------------------------------------------------

/** The env daemon → hub registration (outbound; no open ports). */
export const RelayHello = S.TaggedStruct("relay_hello", {
  envId: S.String,
  token: S.String,
  version: S.String,
});
export type RelayHello = S.Schema.Type<typeof RelayHello>;

/** The worker-side RemoteEnv → hub attach (pipes to the registered env). */
export const RelayAttach = S.TaggedStruct("relay_attach", {
  envId: S.String,
  token: S.String,
  version: S.String,
});
export type RelayAttach = S.Schema.Type<typeof RelayAttach>;

/** Connection-level failure: auth, version mismatch, unknown env. */
export const EnvErrorFrame = S.TaggedStruct("env_error", { message: S.String });
export type EnvErrorFrame = S.Schema.Type<typeof EnvErrorFrame>;

// -- ops ---------------------------------------------------------------------

export const EnvOp = S.Union([
  S.TaggedStruct("health", {}),
  S.TaggedStruct("absolute_path", { path: S.String }),
  S.TaggedStruct("join_path", { parts: S.Array(S.String) }),
  S.TaggedStruct("read_text_file", { path: S.String }),
  S.TaggedStruct("read_text_lines", {
    path: S.String,
    maxLines: S.optional(S.Number),
  }),
  S.TaggedStruct("read_binary_file", { path: S.String }),
  S.TaggedStruct("write_file", {
    path: S.String,
    content: S.String,
    encoding: S.optional(S.Literals(["utf8", "base64"])),
  }),
  S.TaggedStruct("append_file", {
    path: S.String,
    content: S.String,
    encoding: S.optional(S.Literals(["utf8", "base64"])),
  }),
  S.TaggedStruct("rename_file", {
    sourcePath: S.String,
    destinationPath: S.String,
  }),
  S.TaggedStruct("file_info", { path: S.String }),
  S.TaggedStruct("list_dir", { path: S.String }),
  S.TaggedStruct("canonical_path", { path: S.String }),
  S.TaggedStruct("exists", { path: S.String }),
  S.TaggedStruct("create_dir", {
    path: S.String,
    recursive: S.optional(S.Boolean),
  }),
  S.TaggedStruct("remove", {
    path: S.String,
    recursive: S.optional(S.Boolean),
    force: S.optional(S.Boolean),
  }),
  S.TaggedStruct("create_temp_dir", { prefix: S.optional(S.String) }),
  S.TaggedStruct("create_temp_file", {
    prefix: S.optional(S.String),
    suffix: S.optional(S.String),
  }),
  S.TaggedStruct("exec", {
    command: S.String,
    cwd: S.optional(S.String),
    env: S.optional(S.Record(S.String, S.String)),
    /** Seconds; the daemon kills the process on timeout. */
    timeout: S.optional(S.Number),
    inheritEnv: S.optional(S.Boolean),
  }),
]);
export type EnvOp = S.Schema.Type<typeof EnvOp>;

/**
 * The op/payload table, keyed by op tag: every payload is the op's raw
 * value — pi's own shape for file ops (string, string[], FileInfo, ...),
 * `undefined` for mutations. This table is the single source of truth
 * for response payloads, live at both boundaries: the daemon encodes
 * each response against it (daemon.ts), the client decodes each response
 * payload against it (remote.ts) — the wire contract is decoded, never
 * cast.
 */
export const EnvPayloadSchema = {
  health: S.Struct({ cwd: S.String, pid: S.Number, version: S.String }),
  absolute_path: S.String,
  join_path: S.String,
  read_text_file: S.String,
  read_text_lines: S.mutable(S.Array(S.String)),
  read_binary_file: S.String,
  write_file: S.Void,
  append_file: S.Void,
  rename_file: S.Void,
  file_info: EnvFileInfo,
  list_dir: S.mutable(S.Array(EnvFileInfo)),
  canonical_path: S.String,
  exists: S.Boolean,
  create_dir: S.Void,
  remove: S.Void,
  create_temp_dir: S.String,
  create_temp_file: S.String,
  exec: S.Struct({ stdout: S.String, stderr: S.String, exitCode: S.Number }),
} as const satisfies Record<EnvOp["_tag"], S.Schema<unknown>>;

/**
 * The persisted env handle contract (ADR 0003): what the hub hands the
 * worker after provisioning. It crosses the `/set-env-handle` RPC and
 * the thread DO's storage, so it is schema-typed like the rest of the
 * protocol — the JSON shape is the contract.
 */
export const EnvHandle = S.Struct({
  /** The env's endpoint: a `host --private` URL (Box) or the hub relay URL. */
  url: S.String,
  /** The env protocol token the daemon enforces in `env_hello`. */
  token: S.String,
  /** The backing Box, when the env is a sandbox thread's. */
  boxId: S.Union([S.Null, S.String]),
  /**
   * Attach through the hub relay to this registered env (the local
   * machine's daemon, cloud workers) — the direct-URL path otherwise.
   */
  relay: S.optional(S.Struct({ envId: S.String, token: S.String })),
});
export type EnvHandle = S.Schema.Type<typeof EnvHandle>;

/** Reconstruct pi's FileError/ExecutionError classes from a wire error. */
export const toPiError = (error: EnvError): FileError | ExecutionError => {
  if (error.path !== undefined) {
    return new FileError(error.kind as FileErrorCode, error.message, error.path);
  }
  return new ExecutionError(error.kind as ExecutionErrorCode, error.message);
};
