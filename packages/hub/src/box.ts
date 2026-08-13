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

/** A failure of the Box API (auth, limits, provisioning, transport). */
export class BoxError extends Schema.TaggedError<BoxError>()("BoxError", {
  message: Schema.String,
  status: Schema.optional(Schema.Number),
  body: Schema.optional(Schema.Unknown),
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

export interface BoxApi {
  /** Create a box; the returned id is stable for the box's life. */
  readonly createBox: (input: {
    type?: string;
    /** null disables Box's auto-stop (idle-stop is the saku policy). */
    ttlSeconds?: number | null;
    /** Per-box env vars; the thread id tags the box for identification. */
    env?: Record<string, string>;
  }) => Effect.Effect<BoxInfo, BoxError, never>;
  readonly getBox: (boxId: string) => Effect.Effect<BoxInfo, BoxError, never>;
  readonly runCommand: (
    boxId: string,
    command: string,
    options?: { timeoutSeconds?: number; cwd?: string },
  ) => Effect.Effect<CommandResult, BoxError, never>;
  readonly writeFile: (
    boxId: string,
    path: string,
    content: string,
  ) => Effect.Effect<void, BoxError, never>;
  readonly readFile: (boxId: string, path: string) => Effect.Effect<string, BoxError, never>;
  /** Stop and archive (snapshot; billing paused). */
  readonly stop: (boxId: string) => Effect.Effect<void, BoxError, never>;
  readonly resume: (boxId: string) => Effect.Effect<void, BoxError, never>;
}

export interface BoxApiDeps {
  readonly apiKey: string;
  /** Test seam: default is globalThis.fetch. */
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
}

interface Envelope {
  readonly ok: boolean;
  readonly type: string;
  readonly [key: string]: unknown;
}

/**
 * Internal poll failure: the box answered but is not ready yet (the poll
 * retries this; `while` keeps API failures from being retried).
 */
class PollNotReady extends Schema.TaggedError<PollNotReady>()("PollNotReady", {
  status: Schema.String,
}) {}

/** Poll a box until it reaches `ready`/`idle` (provisioning is async). */
export const pollUntilReady = (
  api: BoxApi,
  boxId: string,
  options: { intervalMs?: number; timeoutMs?: number; log?: (message: string) => void } = {},
): Effect.Effect<BoxInfo, BoxError, never> => {
  const intervalMs = options.intervalMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const attempt = Effect.gen(function* () {
    const box = yield* api.getBox(boxId);
    if (box.status === "ready" || box.status === "idle") return box;
    return yield* Effect.fail(new PollNotReady({ status: box.status }));
  });
  return attempt.pipe(
    // Poll every intervalMs until the deadline (Schedule.spaced + upTo;
    // today: self-recursion with a Date.now() deadline). Only the
    // not-ready failure is retried — API failures pass through.
    Effect.retry({
      schedule: Schedule.spaced(`${intervalMs} millis`).pipe(
        Schedule.upTo({ duration: `${timeoutMs} millis` }),
      ),
      while: (error) => error._tag === "PollNotReady",
    }),
    // The schedule gave up: the deadline passed. Today's message, kept.
    Effect.catchTag("PollNotReady", (error) =>
      Effect.fail(
        new BoxError({
          message: `box ${boxId} not ready after ${timeoutMs}ms (status ${error.status})`,
        }),
      ),
    ),
  );
};

/** The client: one request function, thin typed wrappers over it. */
export const makeBoxApi = (deps: BoxApiDeps): BoxApi => {
  const baseUrl = deps.baseUrl ?? "https://ascii.dev/api/box/v1";
  const fetchImpl = deps.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  const request = (
    method: string,
    path: string,
    body?: unknown,
  ): Effect.Effect<unknown, BoxError, never> =>
    Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: () =>
          fetchImpl(`${baseUrl}${path}`, {
            method,
            headers: {
              authorization: `Bearer ${deps.apiKey}`,
              ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        catch: (error) =>
          new BoxError({ message: `box api unreachable: ${String(error)}`, body: error }),
      });
      const text = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: (error) =>
          new BoxError({ message: `box api read failed: ${String(error)}`, body: error }),
      });
      const parsed = Result.try(() => JSON.parse(text) as Envelope);
      const envelope = Result.isSuccess(parsed) ? parsed.success : undefined;
      if (!response.ok) {
        return yield* Effect.fail(
          new BoxError({
            message:
              envelope?.ok === false && typeof envelope?.error === "string"
                ? (envelope.error as string)
                : `box api ${method} ${path} failed: HTTP ${response.status}`,
            status: response.status,
            body: envelope ?? text,
          }),
        );
      }
      return envelope ?? {};
    });

  return {
    createBox: (input) =>
      Effect.gen(function* () {
        const envelope = yield* request("POST", "/boxes", {
          type: input.type ?? "default",
          ttlSeconds: input.ttlSeconds ?? null,
          ...(input.env === undefined ? {} : { env: input.env }),
        });
        const box = (envelope as { box?: { id?: string; status?: string } }).box;
        const id = box?.id ?? (envelope as { id?: string }).id;
        if (id === undefined) {
          return yield* Effect.fail(
            new BoxError({ message: "box created without an id", body: envelope }),
          );
        }
        return { id, status: box?.status ?? "provisioning" };
      }),
    getBox: (boxId) =>
      Effect.gen(function* () {
        const envelope = yield* request("GET", `/boxes/${boxId}`);
        const box = (envelope as { box?: { id?: string; status?: string } }).box;
        const id = box?.id ?? boxId;
        const status = box?.status ?? (envelope as { status?: string }).status;
        if (status === undefined) {
          return yield* Effect.fail(
            new BoxError({ message: `box ${boxId} without a status`, body: envelope }),
          );
        }
        return { id, status };
      }),
    runCommand: (boxId, command, options) =>
      Effect.gen(function* () {
        const envelope = yield* request("POST", `/boxes/${boxId}/commands`, {
          command,
          ...(options?.timeoutSeconds === undefined
            ? {}
            : { timeoutSeconds: options.timeoutSeconds }),
          ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
        });
        const result = envelope as {
          success?: boolean;
          exitCode?: number | null;
          stdout?: string;
          stderr?: string;
        };
        return {
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
          exitCode: result.exitCode ?? -1,
          success: result.success ?? false,
        };
      }),
    writeFile: (boxId, path, content) =>
      Effect.gen(function* () {
        yield* request("PUT", `/boxes/${boxId}/files`, { path, content, encoding: "utf8" });
      }),
    readFile: (boxId, path) =>
      Effect.gen(function* () {
        const envelope = yield* request(
          "GET",
          `/boxes/${boxId}/files?path=${encodeURIComponent(path)}`,
        );
        const content = (envelope as { content?: string }).content;
        if (content === undefined) {
          return yield* Effect.fail(
            new BoxError({ message: `box file ${path} without content`, body: envelope }),
          );
        }
        return content;
      }),
    stop: (boxId) =>
      Effect.gen(function* () {
        yield* request("POST", `/boxes/${boxId}/stop`);
      }),
    resume: (boxId) =>
      Effect.gen(function* () {
        yield* request("POST", `/boxes/${boxId}/resume`);
      }),
  };
};
