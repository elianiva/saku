/**
 * Env stewardship (env.ts): `saku env start|stop|status` — the env
 * daemon's configuration of the shared daemon lifecycle (lifecycle.ts),
 * plus its identity: the on-disk `~/.saku/env.json` (a random envId + env
 * protocol token, minted on the first start — the hub knows the env by
 * that id).
 *
 * The daemon is a detached `node` child running `@saku/env/entry`; its
 * stdout/stderr are appended to `~/.saku/env.log`. With `--hub`, the
 * daemon also registers with the hub's relay (outbound; no open ports).
 * `start` spawns and waits for the daemon's published URL
 * (`~/.saku/env.url`); `status` probes it over the env protocol (the
 * hello carries the pid); `stop` SIGTERMs that pid.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Option, Schema } from "effect";
import { RemoteEnv, getEnvConfigPath, getEnvLogPath, getEnvUrlPath, nodeSocket } from "@saku/env";
import { Paths, type PathsShape } from "@saku/worker";

import { type DaemonLifecycleConfig } from "./lifecycle.ts";

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
const ensureHubToken = Effect.fn("ensureHubToken")(function* (
  paths: PathsShape,
): Effect.fn.Return<string, Error, never> {
  const existing = yield* Effect.tryPromise(() => readFile(paths.authPath, "utf8")).pipe(
    Effect.map((content) => content.trim()),
    Effect.catch(() => Effect.succeed("")),
  );
  if (existing.length > 0) return existing;
  const token = randomBytes(32).toString("hex");
  yield* Effect.tryPromise(() => mkdir(dirname(paths.authPath), { recursive: true, mode: 0o700 }));
  yield* Effect.tryPromise(() => writeFile(paths.authPath, `${token}\n`, { mode: 0o600 }));
  return token;
});

/** Read or create the env identity (random envId + protocol token). */
export const ensureEnvConfig = Effect.fn("ensureEnvConfig")(function* (
  hubUrl?: string,
): Effect.fn.Return<EnvConfig, Error, never> {
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

/** The env daemon's lifecycle: env-protocol probe, --token/--cwd/--hub args. */
export const envLifecycle = Effect.fn("envLifecycle")(function* (
  hubUrl?: string,
): Effect.fn.Return<DaemonLifecycleConfig, never, Paths> {
  const paths = yield* Paths;
  return {
    label: "env daemon",
    entry: resolveEnvEntry(),
    logPath: getEnvLogPath(),
    urlPath: getEnvUrlPath(),
    timeoutCode: "env_timeout",
    readToken: readEnvConfig().pipe(Effect.map(Option.map((config) => config.token))),
    probe: Effect.fn("probe")(function* (identity) {
      const env = new RemoteEnv({ url: identity.url, token: identity.token, socket: nodeSocket });
      const hello = yield* Effect.tryPromise(() => env.connect()).pipe(
        Effect.map(Option.some),
        Effect.catch(() => Effect.succeed(Option.none())),
      );
      env.close();
      return Option.match(hello, {
        onNone: () => Option.none(),
        onSome: (value) =>
          Option.some({ pid: value.pid, version: value.version, cwd: value.cwd }),
      });
    }),
    args: Effect.gen(function* () {
      const config = yield* ensureEnvConfig(hubUrl);
      // The relay credential is the deployment secret (~/.saku/auth, the
      // worker's token); the env daemon presents it in relay_hello. Mint it
      // when absent (the worker's own first-boot habit).
      const hubToken = yield* ensureHubToken(paths);
      return [
        "--token",
        config.token,
        "--cwd",
        process.cwd(),
        ...(config.hubUrl === undefined
          ? []
          : ["--hub", config.hubUrl, "--env-id", config.envId, "--hub-token", hubToken]),
      ];
    }),
  };
});
