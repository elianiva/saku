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
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, FileSystem, Option, Schema } from "effect";
import { RemoteEnv, getEnvConfigPath, getEnvLogPath, getEnvUrlPath, nodeSocket } from "@saku/env";
import { Paths } from "@saku/worker";
import type { PathsLayout } from "@saku/worker";

export const resolveEnvEntry = () => fileURLToPath(import.meta.resolve("@saku/env/entry"));

const EnvConfigSchema = Schema.Struct({
  envId: Schema.String.check(Schema.isMinLength(1)),
  hubUrl: Schema.optional(Schema.String),
  token: Schema.String.check(Schema.isMinLength(1)),
});
export type EnvConfig = Schema.Schema.Type<typeof EnvConfigSchema>;

/** Read the env identity; none before the first `saku env start`. */
export const readEnvConfig = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const content = yield* fs
    .readFileString(getEnvConfigPath())
    .pipe(Effect.catch(() => Effect.succeed("")));
  if (content.length === 0) return Option.none();
  // SAFETY: JSON.parse returns `any`; DECODE_ENV_CONFIG (a Schema.decodeUnknownOption)
  // validates the parsed shape before any field is read, so this cast is the
  // boundary between untrusted JSON and the validated EnvConfig domain type.
  return yield* Effect.try(() => JSON.parse(content) as unknown).pipe(
    Effect.map(Schema.decodeUnknownOption(EnvConfigSchema)),
    Effect.orElseSucceed(() => Option.none()),
  );
});

/** Read ~/.saku/auth, creating it (0600) when absent — the deployment secret. */
const ensureHubToken = Effect.fn("ensureHubToken")(function* (paths: PathsLayout) {
  const fs = yield* FileSystem.FileSystem;
  const existing = yield* fs.readFileString(paths.authPath).pipe(
    Effect.map((content) => content.trim()),
    Effect.catch(() => Effect.succeed("")),
  );
  if (existing.length > 0) {
    return existing;
  }
  const token = randomBytes(32).toString("hex");
  yield* fs.makeDirectory(path.dirname(paths.authPath), { mode: 0o700, recursive: true });
  yield* fs.writeFileString(paths.authPath, `${token}\n`);
  return token;
});

/** Read or create the env identity (random envId + protocol token). */
export const ensureEnvConfig = Effect.fn("ensureEnvConfig")(function* (hubUrl?: string) {
  const existing = yield* readEnvConfig;
  if (Option.isSome(existing)) {
    // A hub switch is honored on start; identity is stable.
    if (hubUrl === undefined || existing.value.hubUrl === hubUrl) {
      return existing.value;
    }
    const fs = yield* FileSystem.FileSystem;
    const updated: EnvConfig = { ...existing.value, hubUrl };
    yield* fs.writeFileString(getEnvConfigPath(), `${JSON.stringify(updated, null, 2)}\n`);
    return updated;
  }
  const config = {
    envId: `env_${randomUUID().replaceAll("-", "")}`,
    token: randomBytes(32).toString("hex"),
  };
  const fs = yield* FileSystem.FileSystem;
  const configWithHub: EnvConfig = hubUrl === undefined ? config : { ...config, hubUrl };
  yield* fs.makeDirectory(path.dirname(getEnvConfigPath()), { mode: 0o700, recursive: true });
  yield* fs.writeFileString(getEnvConfigPath(), `${JSON.stringify(configWithHub, null, 2)}\n`);
  return configWithHub;
});

/** The env daemon's lifecycle: env-protocol probe, --token/--cwd/--hub args. */
export const envLifecycle = Effect.fn("envLifecycle")(function* (hubUrl?: string) {
  const paths = yield* Paths;
  return {
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
    entry: resolveEnvEntry(),
    label: "env daemon" as const,
    logPath: getEnvLogPath(),
    probe: Effect.fn("probe")(function* (identity) {
      const env = new RemoteEnv({ socket: nodeSocket, token: identity.token, url: identity.url });
      const hello = yield* Effect.tryPromise(async () => await env.connect()).pipe(
        Effect.map(Option.some),
        Effect.catch(() => Effect.succeed(Option.none())),
      );
      env.close();
      return Option.match(hello, {
        onNone: () => Option.none(),
        onSome: (value) => Option.some({ cwd: value.cwd, pid: value.pid, version: value.version }),
      });
    }),
    readToken: readEnvConfig.pipe(Effect.map(Option.map((config) => config.token))),
    timeoutCode: "env_timeout" as const,
    urlPath: getEnvUrlPath(),
  };
});
