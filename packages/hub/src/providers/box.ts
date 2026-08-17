/**
 * The ascii.dev Box adapter: provider-specific HTTP calls and the Box-only
 * daemon bootstrap. The hub's generic lifecycle code depends only on the
 * RemoteMachineProvider contract; this module is selected explicitly by
 * deployment wiring.
 */

import { Effect, Result, Schedule, Schema } from "effect";
import { RemoteEnv, nodeSocket } from "@saku/env";
import type { EnvHandle } from "@saku/env";

import { HubError, messageOf } from "../hub-error.ts";
import { pollUntilReady } from "../remote-machine.ts";
import type {
  CommandResult,
  RemoteMachine,
  RemoteMachineProvider,
  RemoteMachineProviderError,
} from "../remote-machine.ts";
import type { EnvProvisioner } from "../provisioner.ts";

const taggedError = Schema.TaggedError;

/** A failure of the Box API (auth, limits, provisioning, transport). */
export class BoxError extends taggedError<BoxError>()("BoxError", {
  body: Schema.optional(Schema.Unknown),
  message: Schema.String,
  status: Schema.optional(Schema.Number),
}) {}

export interface BoxApiDeps {
  readonly apiKey: string;
  /** Test seam: default is globalThis.fetch. */
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
}

/**
 * Response envelope schema: `{ok, type, ...}` per the platform guide, plus
 * the payload fields the v1 endpoints return. Every field is optional so an
 * unparseable body degrades to an empty envelope instead of failing the
 * request.
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

const EMPTY_ENVELOPE: Envelope = {};

interface RequestBody {
  [key: string]: string | number | boolean | null | RequestBody | readonly RequestBody[];
}

/** The Box HTTP client, adapted to the generic remote-machine contract. */
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

    const provider = {
      create: Effect.fn("create")(function* create(input: { env?: Record<string, string> }) {
        const payload: RequestBody = {
          ttlSeconds: null,
          type: "default",
        };
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
      get: Effect.fn("get")(function* get(machineId: string) {
        const envelope = yield* request("GET", `/boxes/${machineId}`);
        const id = envelope.box?.id ?? machineId;
        const status = envelope.box?.status ?? envelope.status;
        if (status === undefined) {
          return yield* Effect.fail(
            new BoxError({ body: envelope, message: `box ${machineId} without a status` }),
          );
        }
        return { id, status };
      }),
      isReady: (machine: RemoteMachine) => machine.status === "ready" || machine.status === "idle",
      readFile: Effect.fn("readFile")(function* readFile(machineId: string, path: string) {
        const envelope = yield* request(
          "GET",
          `/boxes/${machineId}/files?path=${encodeURIComponent(path)}`,
        );
        const { content } = envelope;
        if (content === undefined) {
          return yield* Effect.fail(
            new BoxError({ body: envelope, message: `box file ${path} without content` }),
          );
        }
        return content;
      }),
      resume: Effect.fn("resume")(function* resume(machineId: string) {
        yield* request("POST", `/boxes/${machineId}/resume`);
      }),
      runCommand: Effect.fn("runCommand")(function* runCommand(
        machineId: string,
        command: string,
        options?: { timeoutSeconds?: number; cwd?: string },
      ) {
        const payload: RequestBody = { command };
        if (options?.timeoutSeconds !== undefined) {
          payload.timeoutSeconds = options.timeoutSeconds;
        }
        if (options?.cwd !== undefined) {
          payload.cwd = options.cwd;
        }
        const envelope = yield* request("POST", `/boxes/${machineId}/commands`, payload);
        return {
          exitCode: envelope.exitCode ?? -1,
          stderr: envelope.stderr ?? "",
          stdout: envelope.stdout ?? "",
          success: envelope.success ?? false,
        } satisfies CommandResult;
      }),
      suspend: Effect.fn("suspend")(function* suspend(machineId: string) {
        yield* request("POST", `/boxes/${machineId}/stop`);
      }),
      writeFile: Effect.fn("writeFile")(function* writeFile(
        machineId: string,
        path: string,
        content: string,
      ) {
        yield* request("PUT", `/boxes/${machineId}/files`, { content, encoding: "utf-8", path });
      }),
    } satisfies RemoteMachineProvider<BoxError>;

    return provider;
  },
};

const randomToken = () => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** The node the remote machine gets when it has none. */
export const REMOTE_NODE_VERSION = "v26.7.0";
/** The daemon's fixed in-machine port, exposed by the Box host wrapper. */
export const REMOTE_DAEMON_PORT = 4311;
/** The in-machine layout used by the current daemon bootstrap. */
export const REMOTE_ENV_DIR = "/home/user/.saku-env";

/** The systemd unit used by the current Linux-machine bootstrap. */
export const remoteSystemdUnit = (envToken: string) => `[Unit]
Description=Saku env daemon
After=network.target

[Service]
Type=simple
ExecStart=${REMOTE_ENV_DIR}/run.sh
Restart=always
RestartSec=2
User=user
WorkingDirectory=/home/user
Environment=PATH=/home/user/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=SAKU_ENV_TOKEN=${envToken}
Environment=SAKU_ENV_PORT=${REMOTE_DAEMON_PORT}

[Install]
WantedBy=multi-user.target
`;

/** Box's private-URL wrapper; the `host` command is ascii-specific. */
export const boxRunScript = () => `#!/usr/bin/env bash
set -e
(host ${REMOTE_DAEMON_PORT} --private > ${REMOTE_ENV_DIR}/host.url 2>&1 &)
exec node ${REMOTE_ENV_DIR}/entry.bundle.js --port ${REMOTE_DAEMON_PORT} --token "$SAKU_ENV_TOKEN" --cwd /home/user
`;

/** Ensure node ≥ 26 in the current remote-machine image. */
export const remoteEnsureNodeCommand = () =>
  [
    "command -v node >/dev/null 2>&1 && node --version | grep -qE '^v(2[3-9]|[3-9][0-9])\\.'",
    "|| (mkdir -p /home/user/.local",
    "    && curl -fsSL https://nodejs.org/dist/",
    `${REMOTE_NODE_VERSION}/node-${REMOTE_NODE_VERSION}-linux-x64.tar.xz -o /tmp/node.tar.xz`,
    "    && tar -xJf /tmp/node.tar.xz -C /home/user/.local --strip-components=1)",
  ].join("\n");

/** Install and start the daemon's systemd unit. */
export const remoteInstallCommand = () =>
  [
    "sudo install -m 644",
    `${REMOTE_ENV_DIR}/saku-env.service /etc/systemd/system/saku-env.service`,
    "&& sudo systemctl daemon-reload",
    "&& sudo systemctl enable --now saku-env.service",
  ].join(" ");

export interface BoxProvisionerDeps {
  readonly remoteMachineProvider: RemoteMachineProvider;
  /** The env daemon bundle (one self-contained file). Test seam. */
  readonly readBundle: () => Effect.Effect<string, HubError>;
  /** The env protocol token minted per remote machine (test seam). */
  readonly envToken?: () => string;
  readonly log?: (message: string) => Effect.Effect<void>;
}

const pollOptions = (deps: BoxProvisionerDeps) => (deps.log === undefined ? {} : { log: deps.log });

const toHubError = (context: string) => (cause: unknown) =>
  new HubError({
    cause,
    kind: "provisioner",
    message: `${context}: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

const probeDaemon = Effect.fn("probeDaemon")(function* probeDaemon(url: string, token: string) {
  const env = new RemoteEnv({ socket: nodeSocket, token, url });
  const outcome = yield* Effect.tryPromise({
    catch: (error) => error,
    try: async () => {
      await env.connect();
      env.close();
    },
  }).pipe(Effect.result);
  if (Result.isFailure(outcome)) {
    yield* Effect.fail(
      new HubError({
        kind: "provisioner",
        message: `env daemon did not answer at ${url}: ${messageOf(outcome.failure)}`,
      }),
    );
  }
});

interface HostUrlPending extends RemoteMachineProviderError {
  readonly _tag: "HostUrlPending";
}

const hostUrlPending = () => ({ _tag: "HostUrlPending" }) satisfies HostUrlPending;

const isHostUrlPending = (error: RemoteMachineProviderError): error is HostUrlPending =>
  error._tag === "HostUrlPending";

const readHostUrl = Effect.fn("readHostUrl")(function* readHostUrl(
  deps: BoxProvisionerDeps,
  machineId: string,
) {
  const fail = toHubError(`box ${machineId} host.url read failed`);
  const attempt = Effect.gen(function* attempt() {
    const content = yield* deps.remoteMachineProvider
      .readFile(machineId, `${REMOTE_ENV_DIR}/host.url`)
      .pipe(Effect.mapError(fail));
    const url = content.trim().split("\n")[0] ?? "";
    if (url.length > 0) {
      return url;
    }
    return yield* Effect.fail(hostUrlPending());
  });
  return yield* attempt.pipe(
    Effect.retry({
      schedule: Schedule.spaced("1 seconds").pipe(Schedule.upTo({ duration: "30 seconds" })),
      while: isHostUrlPending,
    }),
    Effect.catchIf(isHostUrlPending, () =>
      Effect.fail(
        new HubError({
          kind: "provisioner",
          message: `box ${machineId} never wrote host.url`,
        }),
      ),
    ),
  );
});

const bootstrapBox = Effect.fn("bootstrapBox")(function* bootstrapBox(
  deps: BoxProvisionerDeps,
  machine: RemoteMachine,
) {
  const log = deps.log ?? (() => Effect.void);
  const fail = toHubError(`box ${machine.id} bootstrap failed`);
  const bundle = yield* deps.readBundle();
  const envToken = deps.envToken?.() ?? randomToken();
  yield* deps.remoteMachineProvider
    .writeFile(machine.id, `${REMOTE_ENV_DIR}/entry.bundle.js`, bundle)
    .pipe(Effect.mapError(fail));
  yield* deps.remoteMachineProvider
    .writeFile(machine.id, `${REMOTE_ENV_DIR}/saku-env.service`, remoteSystemdUnit(envToken))
    .pipe(Effect.mapError(fail));
  yield* deps.remoteMachineProvider
    .writeFile(machine.id, `${REMOTE_ENV_DIR}/run.sh`, boxRunScript())
    .pipe(Effect.mapError(fail));
  yield* deps.remoteMachineProvider
    .runCommand(machine.id, remoteEnsureNodeCommand(), { timeoutSeconds: 600 })
    .pipe(Effect.mapError(fail));
  const install = yield* deps.remoteMachineProvider
    .runCommand(machine.id, remoteInstallCommand(), { timeoutSeconds: 60 })
    .pipe(Effect.mapError(fail));
  if (!install.success) {
    return yield* Effect.fail(
      new HubError({
        kind: "provisioner",
        message: `box ${machine.id} daemon install failed: ${install.stderr.trim() || install.stdout.trim()}`,
      }),
    );
  }
  yield* log(`box ${machine.id} daemon installed; waiting for its URL`);
  const url = yield* readHostUrl(deps, machine.id);
  yield* probeDaemon(url, envToken);
  return { token: envToken, url };
});

const resumeBox = Effect.fn("resumeBox")(function* resumeBox(
  deps: BoxProvisionerDeps,
  machineId: string,
  handle: EnvHandle,
) {
  const fail = toHubError(`box ${machineId} resume failed`);
  yield* deps.remoteMachineProvider.resume(machineId).pipe(Effect.mapError(fail));
  yield* pollUntilReady(deps.remoteMachineProvider, machineId, pollOptions(deps)).pipe(
    Effect.mapError(fail),
  );
  const probe = yield* probeDaemon(handle.url, handle.token).pipe(Effect.result);
  if (Result.isSuccess(probe)) {
    return handle;
  }
  const url = yield* readHostUrl(deps, machineId);
  yield* probeDaemon(url, handle.token);
  return { ...handle, url };
});

/** The Box implementation of the generic env-provisioner seam. */
export const BoxProvisioner = {
  make: (deps: BoxProvisionerDeps) => {
    const ensure: EnvProvisioner["ensure"] = Effect.fn("ensure")(
      function* ensure(thread, remoteMachineId, handle) {
        if (thread.mode !== "sandbox") {
          return { handle: null, remoteMachineId: null };
        }
        if ((remoteMachineId === null) !== (handle === null)) {
          return yield* Effect.fail(
            new HubError({
              kind: "provisioner",
              message: `box env state incomplete for thread ${thread.id.slice(0, 8)}`,
            }),
          );
        }
        if (remoteMachineId !== null && handle !== null) {
          return {
            handle: yield* resumeBox(deps, remoteMachineId, handle),
            remoteMachineId,
          };
        }
        const machine = yield* deps.remoteMachineProvider
          .create({ env: { SAKU_THREAD_ID: thread.id } })
          .pipe(
            Effect.mapError(toHubError(`box creation failed for thread ${thread.id.slice(0, 8)}`)),
          );
        yield* pollUntilReady(deps.remoteMachineProvider, machine.id, pollOptions(deps)).pipe(
          Effect.mapError(toHubError(`box ${machine.id} provisioning failed`)),
        );
        const provisioned = yield* bootstrapBox(deps, machine);
        return { handle: provisioned, remoteMachineId: machine.id };
      },
    );

    const release: EnvProvisioner["release"] = Effect.fn("release")(
      function* release(threadId, remoteMachineId, _handle) {
        if (remoteMachineId === null) {
          return;
        }
        yield* deps.remoteMachineProvider
          .suspend(remoteMachineId)
          .pipe(
            Effect.mapError(
              toHubError(`box ${remoteMachineId} suspend failed (thread ${threadId.slice(0, 8)})`),
            ),
          );
      },
    );

    return { ensure, release };
  },
};
