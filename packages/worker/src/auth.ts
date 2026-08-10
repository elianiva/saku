/**
 * Auth: the daemon's connection token (auth.ts).
 *
 * Created on first daemon boot: 32 random bytes as hex, written 0600. Consoles
 * read the same file and present the token in their `hello` line; the daemon
 * drops sockets that present a different token. `SAKU_HOME` redirects the
 * whole layout (hermetic tests).
 *
 * Every operation is a pure function over an explicit `FileSystem` shape
 * (the same "explicit dependency" style as config-value's `env`); the
 * daemon's layer yields the service once and passes it down, so nothing here
 * touches node:fs or a `*Sync` variant.
 */

import { randomBytes } from "node:crypto";
import { Effect, FileSystem, PlatformError } from "effect";
import { getAuthPath, getSakuDir } from "./paths.ts";

/** Ensure the saku home directory exists. */
export const ensureSakuDirs = (fs: FileSystem.FileSystem): Effect.Effect<void, PlatformError.PlatformError, never> =>
  fs.makeDirectory(getSakuDir(), { recursive: true, mode: 0o700 });

/** Read the token without creating anything. Absent/unreadable/empty → undefined. */
export const readAuthToken = (fs: FileSystem.FileSystem): Effect.Effect<string | undefined, never, never> =>
  fs.readFileString(getAuthPath()).pipe(
    Effect.map((content) => {
      const token = content.trim();
      return token.length > 0 ? token : undefined;
    }),
    Effect.catchEager(() => Effect.succeed(undefined)),
  );

/** Read the token, creating it (and its directory) when absent. */
export const ensureAuthToken = (fs: FileSystem.FileSystem): Effect.Effect<string, PlatformError.PlatformError, never> =>
  Effect.gen(function* () {
    const existing = yield* readAuthToken(fs);
    if (existing !== undefined) return existing;
    yield* ensureSakuDirs(fs);
    const token = randomBytes(32).toString("hex");
    yield* fs.writeFileString(getAuthPath(), `${token}\n`, { mode: 0o600 });
    yield* fs.chmod(getAuthPath(), 0o600);
    return token;
  });
