/**
 * The env provisioner (provisioner.ts): the hub's interface to a thread's
 * hands (ADR 0003) — local mode is the user's machine (a registered env
 * daemon), sandbox mode is a Box provisioned through the Box API.
 *
 * `ensure` makes the env answer: for a Box, create (lazily, on the first
 * mutating command) or resume (idle-stop put it to sleep), bootstrap the
 * env daemon, and health-probe the `host --private` URL before declaring
 * `ready`. `release` stops the Box (idle-stop trigger, or thread
 * deletion). The returned `EnvHandle` is what the hub persists and hands
 * to the worker (ADR 0003: the worker never knows which host it is).
 *
 * Box bootstrap (one-time per box):
 *
 * 1. `PUT` the daemon bundle (`dist/entry.bundle.js` — one self-contained
 *    file) and a systemd unit + wrapper script into `/home/user/.saku-env/`
 * 2. ensure a node ≥ 26 runtime (the box's own, or a pinned official
 *    tarball into `~/.local`)
 * 3. `systemctl enable --now saku-env` — the unit runs a wrapper that
 *    starts `host 4311 --private` (writing its URL to `host.url`) and then
 *    the daemon; enabled services survive stop/resume, so the daemon is
 *    back automatically on resume
 * 4. read `host.url` and probe the URL with the env protocol's hello —
 *    ready is only ready when the daemon answers
 *
 * The resume path re-probes the stored URL first (a `host` URL is stable
 * for the box's life; if it changed, re-read `host.url`), then polls the
 * box to `ready` — systemd brings the daemon back during resume.
 */

import { Effect, Option, Result, Schedule, Schema } from "effect";
import { RemoteEnv, nodeSocket, type EnvHandle } from "@saku/env";
import { HubError, makeHubError, messageOf } from "./hub-error.ts";
import type { HubRecord } from "./registry.ts";
import { pollUntilReady, type BoxApi, type BoxInfo } from "./box.ts";

/** A fresh env protocol token (the daemon's credential). */
const randomToken = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
};

/** The node the box gets when it has none (official binary tarball). */
export const BOX_NODE_VERSION = "v26.7.0";

/** The daemon's fixed in-box port (the wrapper's `host` fronts it). */
export const BOX_DAEMON_PORT = 4311;

/** The in-box layout the bootstrap writes. */
export const BOX_ENV_DIR = "/home/user/.saku-env";

/** The systemd unit: wrapper (host + daemon), enabled for resume survival. */
export const boxSystemdUnit = (envToken: string): string => `[Unit]
Description=Saku env daemon
After=network.target

[Service]
Type=simple
ExecStart=${BOX_ENV_DIR}/run.sh
Restart=always
RestartSec=2
User=user
WorkingDirectory=/home/user
Environment=PATH=/home/user/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=SAKU_ENV_TOKEN=${envToken}
Environment=SAKU_ENV_PORT=${BOX_DAEMON_PORT}

[Install]
WantedBy=multi-user.target
`;

/** The wrapper: start `host --private` (URL → host.url), then the daemon. */
export const boxRunScript = (): string => `#!/usr/bin/env bash
set -e
# The host proxy gives the daemon its stable HTTPS URL; its output carries
# the URL, so the hub reads host.url to learn where the env answers.
(host ${BOX_DAEMON_PORT} --private > ${BOX_ENV_DIR}/host.url 2>&1 &)
exec node ${BOX_ENV_DIR}/entry.bundle.js --port ${BOX_DAEMON_PORT} --token "$SAKU_ENV_TOKEN" --cwd /home/user
`;

/** Ensure node ≥ 26 in the box (the daemon needs type-stripping-era node). */
export const boxEnsureNodeCommand = (): string =>
  [
    "command -v node >/dev/null 2>&1 && node --version | grep -qE '^v(2[3-9]|[3-9][0-9])\\.'",
    "|| (mkdir -p /home/user/.local",
    "    && curl -fsSL https://nodejs.org/dist/",
    `${BOX_NODE_VERSION}/node-${BOX_NODE_VERSION}-linux-x64.tar.xz -o /tmp/node.tar.xz`,
    "    && tar -xJf /tmp/node.tar.xz -C /home/user/.local --strip-components=1)",
  ].join("\n");

/** Install the unit and start the daemon. */
export const boxInstallCommand = (): string =>
  [
    "sudo install -m 644",
    `${BOX_ENV_DIR}/saku-env.service /etc/systemd/system/saku-env.service`,
    "&& sudo systemctl daemon-reload",
    "&& sudo systemctl enable --now saku-env.service",
  ].join(" ");

export interface ProvisionerDeps {
  readonly boxApi: BoxApi;
  /** The env daemon bundle (one self-contained file). Test seam. */
  readonly readBundle: () => Effect.Effect<string, HubError, never>;
  /** The env protocol token minted per box (test seam; random by default). */
  readonly envToken?: () => string;
  readonly log?: (message: string) => Effect.Effect<void, never, never>;
}

export interface EnvProvisioner {
  /**
   * Make the thread's env answer. Local threads have no handle (the local
   * daemon serves them; the relay path lands with the DO worker in M4).
   * Sandbox threads return the handle to persist. Fails → the hub flips
   * the env axis to `error`.
   */
  readonly ensure: (
    thread: HubRecord,
    handle: Option.Option<EnvHandle>,
  ) => Effect.Effect<Option.Option<EnvHandle>, HubError, never>;
  /** Release the env: stop the Box (idle-stop trigger, thread deletion). */
  readonly release: (
    threadId: string,
    handle: Option.Option<EnvHandle>,
  ) => Effect.Effect<void, HubError, never>;
}

/** Poll options with the provisioner's log when set (exactOptional-safe). */
const pollOptions = (deps: ProvisionerDeps): { log?: (message: string) => Effect.Effect<void, never, never> } =>
  deps.log === undefined ? {} : { log: deps.log };

const toHubError =
  (context: string) =>
  (error: unknown): HubError =>
    makeHubError(
      "provisioner",
      `${context}: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );

/** Probe an env URL with the protocol's hello; answers = ready. */
const probeDaemon = (url: string, token: string): Effect.Effect<void, HubError, never> =>
  Effect.gen(function* () {
    const env = new RemoteEnv({ url, token, socket: nodeSocket });
    // The rejection reason is unknown (never `as Error`): the failure arm
    // below messages it via messageOf.
    const outcome = yield* Effect.tryPromise({
      try: () => env.connect().then(() => env.close()),
      catch: (error) => error,
    }).pipe(Effect.result);
    if (Result.isFailure(outcome)) {
      return yield* Effect.fail(
        makeHubError(
          "provisioner",
          `env daemon did not answer at ${url}: ${messageOf(outcome.failure)}`,
        ),
      );
    }
  });

/**
 * Bootstrap the daemon into a fresh box: bundle + unit + node, then the
 * install command, then read the host URL and probe it.
 */
const bootstrapBox = (
  deps: ProvisionerDeps,
  thread: HubRecord,
  box: BoxInfo,
): Effect.Effect<EnvHandle, HubError, never> =>
  Effect.gen(function* () {
    const log = deps.log ?? (() => Effect.void);
    const fail = toHubError(`box ${box.id} bootstrap failed`);
    const bundle = yield* deps.readBundle();
    const envToken = deps.envToken?.() ?? randomToken();
    yield* deps.boxApi
      .writeFile(box.id, `${BOX_ENV_DIR}/entry.bundle.js`, bundle)
      .pipe(Effect.mapError(fail));
    yield* deps.boxApi
      .writeFile(box.id, `${BOX_ENV_DIR}/saku-env.service`, boxSystemdUnit(envToken))
      .pipe(Effect.mapError(fail));
    yield* deps.boxApi
      .writeFile(box.id, `${BOX_ENV_DIR}/run.sh`, boxRunScript())
      .pipe(Effect.mapError(fail));
    yield* deps.boxApi
      .runCommand(box.id, boxEnsureNodeCommand(), { timeoutSeconds: 600 })
      .pipe(Effect.mapError(fail));
    const install = yield* deps.boxApi
      .runCommand(box.id, boxInstallCommand(), { timeoutSeconds: 60 })
      .pipe(Effect.mapError(fail));
    if (!install.success) {
      return yield* Effect.fail(
        makeHubError(
          "provisioner",
          `box ${box.id} daemon install failed: ${install.stderr.trim() || install.stdout.trim()}`,
        ),
      );
    }
    yield* log(`box ${box.id} daemon installed; waiting for its URL`);
    // The wrapper writes host.url shortly after systemd starts it.
    const url = yield* readHostUrl(deps, box.id);
    yield* probeDaemon(url, envToken);
    return { url, token: envToken, boxId: box.id };
  });

/** The host.url read found nothing (the wrapper hasn't written it yet). */
class HostUrlPending extends Schema.TaggedError<HostUrlPending>()("HostUrlPending", {}) {}

/** Read the box's host.url, retrying until the wrapper has written it. */
const readHostUrl = (
  deps: ProvisionerDeps,
  boxId: string,
): Effect.Effect<string, HubError, never> =>
  Effect.gen(function* () {
    const fail = toHubError(`box ${boxId} host.url read failed`);
    const attempt = Effect.gen(function* () {
      const content = yield* deps.boxApi
        .readFile(boxId, `${BOX_ENV_DIR}/host.url`)
        .pipe(Effect.mapError(fail));
      const url = content.trim().split("\n")[0] ?? "";
      if (url.length > 0) return url;
      return yield* Effect.fail(new HostUrlPending());
    });
    return yield* attempt.pipe(
      // Poll every second until the deadline (Schedule.spaced + upTo, the
      // box.ts pollUntilReady idiom: interruptible, deadline-bounded). Only
      // the not-yet-written failure is retried — read failures pass through.
      Effect.retry({
        schedule: Schedule.spaced("1 seconds").pipe(Schedule.upTo({ duration: "30 seconds" })),
        while: (error) => error._tag === "HostUrlPending",
      }),
      // The schedule gave up: the wrapper never wrote the URL. Today's message, kept.
      Effect.catchTag("HostUrlPending", () =>
        Effect.fail(makeHubError("provisioner", `box ${boxId} never wrote host.url`)),
      ),
    );
  });

/** Resume a stopped box: wake it, wait, re-probe (re-read the URL if it moved). */
const resumeBox = (
  deps: ProvisionerDeps,
  thread: HubRecord,
  handle: EnvHandle,
): Effect.Effect<EnvHandle, HubError, never> =>
  Effect.gen(function* () {
    const fail = toHubError(`box ${handle.boxId ?? "?"} resume failed`);
    if (handle.boxId === null) {
      return yield* Effect.fail(makeHubError("provisioner", "sandbox thread without a box id"));
    }
    yield* deps.boxApi.resume(handle.boxId).pipe(Effect.mapError(fail));
    yield* pollUntilReady(deps.boxApi, handle.boxId, pollOptions(deps)).pipe(Effect.mapError(fail));
    // systemd restarts the daemon on resume; the URL should be the same one.
    const probe = yield* probeDaemon(handle.url, handle.token).pipe(Effect.result);
    if (Result.isSuccess(probe)) return handle;
    const url = yield* readHostUrl(deps, handle.boxId);
    yield* probeDaemon(url, handle.token);
    return { ...handle, url };
  });

export const makeProvisioner = (deps: ProvisionerDeps): EnvProvisioner => {
  const ensure: EnvProvisioner["ensure"] = (thread, handle) =>
    Effect.gen(function* () {
      if (thread.mode !== "sandbox") {
        // Local threads are served by the local env daemon (M3: the
        // transitional worker daemon serves them in-process); no handle.
        return Option.none();
      }
      if (Option.isSome(handle)) {
        const resumed = yield* resumeBox(deps, thread, handle.value);
        return Option.some(resumed);
      }
      const box = yield* deps.boxApi
        .createBox({
          type: "default",
          // No wall-clock auto-stop: idle-stop is the saku policy (ADR 0003).
          ttlSeconds: null,
          // The thread id tags the box (platform guide: identify boxes).
          env: { SAKU_THREAD_ID: thread.id },
        })
        .pipe(
          Effect.mapError(toHubError(`box creation failed for thread ${thread.id.slice(0, 8)}`)),
        );
      yield* pollUntilReady(deps.boxApi, box.id, pollOptions(deps)).pipe(
        Effect.mapError(toHubError(`box ${box.id} provisioning failed`)),
      );
      const provisioned = yield* bootstrapBox(deps, thread, box);
      return Option.some(provisioned);
    });

  const release: EnvProvisioner["release"] = (threadId, handle) =>
    Effect.gen(function* () {
      if (Option.isNone(handle) || handle.value.boxId === null) {
        // Local envs never stop (ADR 0003).
        return;
      }
      yield* deps.boxApi
        .stop(handle.value.boxId)
        .pipe(
          Effect.mapError(
            toHubError(`box ${handle.value.boxId} stop failed (thread ${threadId.slice(0, 8)})`),
          ),
        );
    });

  return { ensure, release };
};
