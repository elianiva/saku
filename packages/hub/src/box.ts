/**
 * The Box API client (box.ts): the hub's only interface to the sandbox
 * provider (ascii.dev, ADR 0003). One Box per thread, created with
 * `ttlSeconds: null` (`--no-auto-stop` — Box's own wall-clock TTL fires
 * mid-work and is useless to us; idle-stop is the saku policy), tagged
 * with the thread id via `env`, and driven through the documented v1
 * endpoints: create → poll `ready`/`idle` → commands/files → stop/resume.
 *
 * The transport is an injectable `fetch` (tests script a stub), the
 * response envelope is `{ok, type, ...}` with HTTP status authoritative.
 * The full platform guide is at https://docs.ascii.dev/box/platform-guide.
 */

import { Effect, Result, Schedule, Schema } from "effect";

/**
 * Aliased so the TaggedError class declarations below stay plain calls
 * (oxlint's throw-new-error would demand `new`, which breaks the schema
 * typecheck — `TaggedError` is a function returning a class, not a class).
 */
const taggedError = Schema.TaggedError;

/** A failure of the Box API (auth, limits, provisioning, transport). */
export class BoxError extends taggedError<BoxError>()("BoxError", {
  body: Schema.optional(Schema.Unknown),
  message: Schema.String,
  status: Schema.optional(Schema.Number),
}) {}

export interface BoxInfo {
  readonly id: string;
  readonly status: string;
}

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly success: boolean;
}

export interface BoxApiContract {
  /** Create a box; the returned id is stable for the box's life. */
  readonly createBox: (input: {
    type?: string;
    /** null disables Box's auto-stop (idle-stop is the saku policy). */
    ttlSeconds?: number | null;
    /** Per-box env vars; the thread id tags the box for identification. */
    env?: Record<string, string>;
  }) => Effect.Effect<BoxInfo, BoxError>;
  readonly getBox: (boxId: string) => Effect.Effect<BoxInfo, BoxError>;
  readonly runCommand: (
    boxId: string,
    command: string,
    options?: { timeoutSeconds?: number; cwd?: string },
  ) => Effect.Effect<CommandResult, BoxError>;
  readonly writeFile: (
    boxId: string,
    path: string,
    content: string,
  ) => Effect.Effect<void, BoxError>;
  readonly readFile: (boxId: string, path: string) => Effect.Effect<string, BoxError>;
  /** Stop and archive (snapshot; billing paused). */
  readonly stop: (boxId: string) => Effect.Effect<void, BoxError>;
  readonly resume: (boxId: string) => Effect.Effect<void, BoxError>;
}

export interface BoxApiDeps {
  readonly apiKey: string;
  /** Test seam: default is globalThis.fetch. */
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
}

/**
 * Response envelope schema: `{ok, type, ...}` per the platform guide, plus
 * the payload fields the v1 endpoints return (parsed at the I/O boundary
 * before they are read). Every field is optional so an unparseable body
 * degrades to an empty envelope instead of failing the request.
 */
const EnvelopeSchema = Schema.Struct({
  box: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        id: Schema.optional(Schema.String),
        status: Schema.optional(Schema.String),
      }),
    ),
  ),
  content: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.NullOr(Schema.Number)),
  id: Schema.optional(Schema.String),
  ok: Schema.optional(Schema.Boolean),
  status: Schema.optional(Schema.String),
  stderr: Schema.optional(Schema.String),
  stdout: Schema.optional(Schema.String),
  success: Schema.optional(Schema.Boolean),
  type: Schema.optional(Schema.String),
});

type Envelope = Schema.Schema.Type<typeof EnvelopeSchema>;

/** Degenerate envelope: every field is optional, so `{}` stands in. */
const EMPTY_ENVELOPE: Envelope = {};

/**
 * A JSON-serializable request payload for the Box v1 endpoints (built
 * inline at each call site).
 */
interface RequestBody {
  [key: string]: string | number | boolean | null | RequestBody | readonly RequestBody[];
}

/**
 * Internal poll failure: the box answered but is not ready yet (the poll
 * retries this; `while` keeps API failures from being retried).
 */
interface PollNotReady {
  readonly _tag: "PollNotReady";
  readonly status: string;
}

const PollNotReady = taggedError<PollNotReady>()("PollNotReady", {
  status: Schema.String,
});

/** Poll a box until it reaches `ready`/`idle` (provisioning is async). */
export const pollUntilReady = (
  api: BoxApiContract,
  boxId: string,
  options: {
    intervalMs?: number;
    timeoutMs?: number;
    log?: (message: string) => Effect.Effect<void>;
  } = {},
) => {
  const intervalMs = options.intervalMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const attempt = Effect.gen(function* attempt() {
    const box = yield* api.getBox(boxId);
    if (box.status === "ready" || box.status === "idle") {
      return box;
    }
    return yield* Effect.fail(new PollNotReady({ status: box.status }));
  });
  return attempt.pipe(
    // Poll every intervalMs until the deadline (Schedule.spaced + upTo:
    // interruptible, deadline-bounded — the Clock can fake it in tests).
    // Only the not-ready failure is retried — API failures pass through.
    Effect.retry({
      schedule: Schedule.spaced(`${intervalMs} millis`).pipe(
        Schedule.upTo({ duration: `${timeoutMs} millis` }),
      ),
      while: (error) => error._tag === "PollNotReady",
    }),
    // The schedule gave up: the deadline passed. Today's message, kept.
    Effect.catchTag("PollNotReady", (notReady) =>
      Effect.fail(
        new BoxError({
          message: `box ${boxId} not ready after ${timeoutMs}ms (status ${notReady.status})`,
        }),
      ),
    ),
  );
};

/** The Box HTTP client: `BoxApi.make(deps)` builds one. */
export const BoxApi = {
  make: (deps: BoxApiDeps) => {
    const baseUrl = deps.baseUrl ?? "https://ascii.dev/api/box/v1";
    const fetchImpl =
      deps.fetch ?? (async (...args: Parameters<typeof fetch>) => await fetch(...args));

    const request = Effect.fn("request")(function* request(
      method: string,
      path: string,
      body?: RequestBody,
    ) {
      const headers = new Headers({ authorization: `Bearer ${deps.apiKey}` });
      if (body !== undefined) {
        headers.set("content-type", "application/json");
      }
      const init: RequestInit = { headers, method };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }
      const response = yield* Effect.tryPromise({
        catch: (error) =>
          new BoxError({ body: error, message: `box api unreachable: ${String(error)}` }),
        try: async () => await fetchImpl(`${baseUrl}${path}`, init),
      });
      const text = yield* Effect.tryPromise({
        catch: (error) =>
          new BoxError({ body: error, message: `box api read failed: ${String(error)}` }),
        try: async () => await response.text(),
      });
      const parsed = Result.try(() => Schema.decodeUnknownSync(EnvelopeSchema)(JSON.parse(text)));
      const envelope = Result.isSuccess(parsed) ? parsed.success : undefined;
      if (!response.ok) {
        return yield* Effect.fail(
          new BoxError({
            body: envelope ?? text,
            message:
              envelope?.ok === false && envelope.error !== undefined
                ? envelope.error
                : `box api ${method} ${path} failed: HTTP ${response.status}`,
            status: response.status,
          }),
        );
      }
      return envelope ?? EMPTY_ENVELOPE;
    });

    return {
      createBox: Effect.fn("createBox")(function* createBox(input: {
        type?: string;
        ttlSeconds?: number | null;
        env?: Record<string, string>;
      }) {
        const payload: RequestBody = {};
        payload.ttlSeconds = input.ttlSeconds ?? null;
        payload.type = input.type ?? "default";
        if (input.env !== undefined) {
          payload.env = input.env;
        }
        const envelope = yield* request("POST", "/boxes", payload);
        const id = envelope.box?.id ?? envelope.id;
        if (id === undefined) {
          return yield* Effect.fail(
            new BoxError({ body: envelope, message: "box created without an id" }),
          );
        }
        return { id, status: envelope.box?.status ?? "provisioning" };
      }),
      getBox: Effect.fn("getBox")(function* getBox(boxId: string) {
        const envelope = yield* request("GET", `/boxes/${boxId}`);
        const id = envelope.box?.id ?? boxId;
        const status = envelope.box?.status ?? envelope.status;
        if (status === undefined) {
          return yield* Effect.fail(
            new BoxError({ body: envelope, message: `box ${boxId} without a status` }),
          );
        }
        return { id, status };
      }),
      readFile: Effect.fn("readFile")(function* readFile(boxId: string, path: string) {
        const envelope = yield* request(
          "GET",
          `/boxes/${boxId}/files?path=${encodeURIComponent(path)}`,
        );
        const { content } = envelope;
        if (content === undefined) {
          return yield* Effect.fail(
            new BoxError({ body: envelope, message: `box file ${path} without content` }),
          );
        }
        return content;
      }),
      resume: Effect.fn("resume")(function* resume(boxId: string) {
        yield* request("POST", `/boxes/${boxId}/resume`);
      }),
      runCommand: Effect.fn("runCommand")(function* runCommand(
        boxId: string,
        command: string,
        options?: { timeoutSeconds?: number; cwd?: string },
      ) {
        const payload: RequestBody = {};
        payload.command = command;
        if (options?.timeoutSeconds !== undefined) {
          payload.timeoutSeconds = options.timeoutSeconds;
        }
        if (options?.cwd !== undefined) {
          payload.cwd = options.cwd;
        }
        const envelope = yield* request("POST", `/boxes/${boxId}/commands`, payload);
        return {
          exitCode: envelope.exitCode ?? -1,
          stderr: envelope.stderr ?? "",
          stdout: envelope.stdout ?? "",
          success: envelope.success ?? false,
        };
      }),
      stop: Effect.fn("stop")(function* stop(boxId: string) {
        yield* request("POST", `/boxes/${boxId}/stop`);
      }),
      writeFile: Effect.fn("writeFile")(function* writeFile(
        boxId: string,
        path: string,
        content: string,
      ) {
        yield* request("PUT", `/boxes/${boxId}/files`, { content, encoding: "utf-8", path });
      }),
    };
  },
};
