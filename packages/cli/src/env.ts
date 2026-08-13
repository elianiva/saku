/**
 * Env stewardship (env.ts): `saku env start|stop|status` — manage the
 * local env daemon (ADR 0003, plan 0001 §6). Everything else is the
 * wire's job, proven by tests.
 *
 * The daemon is a detached `node` child running `@saku/env/entry`; its
 * stdout/stderr are appended to `~/.saku/env.log`. Identity lives in
 * `~/.saku/env.json`: a random envId + env protocol token, minted on the
 * first start (the hub knows the env by that id). With `--hub`, the
 * daemon also registers with the hub's relay (outbound; no open ports).
 *
 * `start` spawns and waits for the daemon's published URL
 * (`~/.saku/env.url`); `status` probes it over the env protocol (the
 * hello carries the pid); `stop` SIGTERMs that pid.
 */

import { spawn } from "node:child_process";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Option, Schedule, Schema } from "effect";
import { RemoteEnv, nodeSocket } from "@saku/env";
import { getEnvConfigPath, getEnvLogPath, getEnvUrlPath } from "@saku/env";
import { getAuthPath } from "@saku/worker";

export const resolveEnvEntry = (): string => fileURLToPath(import.meta.resolve("@saku/env/entry"));

const EnvConfigSchema = Schema.Struct({
  envId: Schema.String.check(Schema.isMinLength(1)),
  token: Schema.String.check(Schema.isMinLength(1)),
  hubUrl: Schema.optional(Schema.String),
});
const DECODE_ENV_CONFIG = Schema.decodeUnknownOption(EnvConfigSchema);
export type EnvConfig = Schema.Schema.Type<typeof EnvConfigSchema>;

/** Read the env identity; none before the first `saku env start`. */
export const readEnvConfig = (): Effect.Effect<Option.Option<EnvConfig>, never, never> =>
  Effect.tryPromise(() => readFile(getEnvConfigPath(), "utf8")).pipe(
    Effect.flatMap((content) => Effect.try(() => JSON.parse(content) as unknown)),
    Effect.map(DECODE_ENV_CONFIG),
    Effect.catch(() => Effect.succeed(Option.none())),
  );

/** Read ~/.saku/auth, creating it (0600) when absent — the deployment secret. */
const ensureHubToken = (): Effect.Effect<string, Error, never> =>
  Effect.gen(function* () {
    const existing = yield* Effect.tryPromise(() => readFile(getAuthPath(), "utf8")).pipe(
      Effect.map((content) => content.trim()),
      Effect.catch(() => Effect.succeed("")),
    );
    if (existing.length > 0) return existing;
    const token = randomBytes(32).toString("hex");
    yield* Effect.tryPromise(() => mkdir(dirname(getAuthPath()), { recursive: true, mode: 0o700 }));
    yield* Effect.tryPromise(() => writeFile(getAuthPath(), `${token}\n`, { mode: 0o600 }));
    return token;
  });

/** Read or create the env identity (random envId + protocol token). */
export const ensureEnvConfig = (hubUrl?: string): Effect.Effect<EnvConfig, Error, never> =>
  Effect.gen(function* () {
    const existing = yield* readEnvConfig();
    if (Option.isSome(existing)) {
      // A hub switch is honored on start; identity is stable.
      if (hubUrl === undefined || existing.value.hubUrl === hubUrl) return existing.value;
      const updated: EnvConfig = { ...existing.value, hubUrl };
      yield* Effect.tryPromise(() =>
        writeFile(getEnvConfigPath(), `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 }),
      );
      return updated;
    }
    const config: EnvConfig = {
      envId: `env_${randomUUID().replaceAll("-", "")}`,
      token: randomBytes(32).toString("hex"),
      ...(hubUrl === undefined ? {} : { hubUrl }),
    };
    yield* Effect.tryPromise(() =>
      mkdir(dirname(getEnvConfigPath()), { recursive: true, mode: 0o700 }),
    );
    yield* Effect.tryPromise(() =>
      writeFile(getEnvConfigPath(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 }),
    );
    return config;
  });

/** The daemon's published ws URL; none when the daemon has never run. */
export const readEnvUrl = (): Effect.Effect<Option.Option<string>, never, never> =>
  Effect.tryPromise(() => readFile(getEnvUrlPath(), "utf8")).pipe(
    Effect.map((content) =>
      Option.some(content.trim()).pipe(Option.filter((value) => value.length > 0)),
    ),
    Effect.catch(() => Effect.succeed(Option.none())),
  );

export interface EnvStatus {
  readonly running: boolean;
  readonly pid?: number;
  readonly version?: string;
  readonly cwd?: string;
}

/** Probe the daemon over the env protocol; never fails, never leaks a socket. */
export const envStatus = (): Effect.Effect<EnvStatus, never, never> =>
  Effect.gen(function* () {
    const url = yield* readEnvUrl();
    const config = yield* readEnvConfig();
    if (Option.isNone(url) || Option.isNone(config)) return { running: false };
    const env = new RemoteEnv({ url: url.value, token: config.value.token, socket: nodeSocket });
    const hello = yield* Effect.tryPromise(() => env.connect()).pipe(
      Effect.map(Option.some),
      Effect.catch(() => Effect.succeed(Option.none())),
    );
    env.close();
    return Option.match(hello, {
      onNone: () => ({ running: false }),
      onSome: (value) => ({
        running: true,
        pid: value.pid,
        version: value.version,
        cwd: value.cwd,
      }),
    });
  });

/** Spawn a detached env daemon; returns its pid (0 when spawn failed). */
export const spawnEnvDaemon = (config: EnvConfig): Effect.Effect<number, Error, never> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      mkdir(dirname(getEnvLogPath()), { recursive: true, mode: 0o700 }),
    );
    const logFd = yield* Effect.tryPromise(() => open(getEnvLogPath(), "a"));
    // The relay credential is the deployment secret (~/.saku/auth, the
    // worker's token); the env daemon presents it in relay_hello. Mint it
    // when absent (the worker's own first-boot habit).
    const hubToken = yield* ensureHubToken();
    const args = [
      resolveEnvEntry(),
      "--token",
      config.token,
      "--cwd",
      process.cwd(),
      ...(config.hubUrl === undefined
        ? []
        : ["--hub", config.hubUrl, "--env-id", config.envId, "--hub-token", hubToken]),
    ];
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ["ignore", logFd.fd, logFd.fd],
    });
    // The child holds the inherited fd; drop the parent's handle.
    yield* Effect.tryPromise(() => logFd.close());
    child.unref();
    return child.pid ?? 0;
  });

/** Spawn if needed and wait until the env answers. Returns the pid. */
export const ensureEnvDaemon = (config: EnvConfig): Effect.Effect<number, Error, never> =>
  Effect.gen(function* () {
    const status = yield* envStatus();
    if (status.running && status.pid !== undefined) return status.pid;
    const pid = yield* spawnEnvDaemon(config);
    const now = yield* waitForEnvDaemon().pipe(
      Effect.mapError(
        () => new Error(`env daemon did not come up (spawned pid ${pid}); see ${getEnvLogPath()}`),
      ),
    );
    return now.pid;
  });

/**
 * Probe until the env daemon answers: first probe + 99 retries, 100 ms apart.
 * The error channel is the retry-exhausted probe failure (`undefined`).
 */
const waitForEnvDaemon = (): Effect.Effect<EnvStatus & { pid: number }, undefined, never> =>
  envStatus().pipe(
    Effect.filterOrFail(
      (status): status is EnvStatus & { pid: number } => status.running && status.pid !== undefined,
      () => undefined,
    ),
    Effect.retry({ times: 99, schedule: Schedule.spaced("100 millis") }),
  );

/** Probe until the env daemon is gone: first probe + 49 retries, 100 ms apart. */
const waitForEnvStop = (): Effect.Effect<void, never, never> =>
  envStatus().pipe(
    Effect.filterOrFail(
      (status) => !status.running,
      () => undefined,
    ),
    Effect.retry({ times: 49, schedule: Schedule.spaced("100 millis") }),
    // 50 probes exhausted: give up silently, like the old loop's break.
    Effect.catch(() => Effect.void),
  );

/** Stop the env daemon; returns the pid that was stopped, or none. */
export const stopEnvDaemon = (): Effect.Effect<Option.Option<number>, never, never> =>
  Effect.gen(function* () {
    const status = yield* envStatus();
    if (!status.running || status.pid === undefined) return Option.none();
    const pid = status.pid;
    // Already gone is fine — the process was reaped between the probe and now.
    yield* Effect.try(() => process.kill(pid, "SIGTERM")).pipe(Effect.catch(() => Effect.void));
    yield* waitForEnvStop();
    return Option.some(pid);
  });
