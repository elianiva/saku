/**
 * Auth: the daemon's connection token (auth.ts).
 *
 * Created on first daemon boot: 32 random bytes as hex, written 0600. Consoles
 * read the same file and present the token in their `hello` line; the daemon
 * drops sockets that present a different token. The layout comes from the
 * caller's `Paths` service (`SAKU_HOME` redirects the whole layout — hermetic
 * tests).
 *
 * Every operation is a pure function over an explicit `FileSystem` and
 * `PathsShape` (the same "explicit dependency" style as config-value's
 * `env`); the daemon's layer yields the services once and passes them down,
 * so nothing here touches node:fs or a `*Sync` variant.
 */

import { randomBytes } from "node:crypto";
import { Effect, FileSystem, PlatformError } from "effect";
import type { PathsShape } from "./paths.ts";

/** Ensure the saku home directory exists. */
export const ensureSakuDirs = (
  fs: FileSystem.FileSystem,
  paths: PathsShape,
): Effect.Effect<void, PlatformError.PlatformError, never> =>
  fs.makeDirectory(paths.sakuDir, { recursive: true, mode: 0o700 });

/** Read the token without creating anything. Absent/unreadable/empty → undefined. */
export const readAuthToken = (
  fs: FileSystem.FileSystem,
  paths: PathsShape,
): Effect.Effect<string | undefined, never, never> =>
  fs.readFileString(paths.authPath).pipe(
    Effect.map((content) => {
      const token = content.trim();
      return token.length > 0 ? token : undefined;
    }),
    Effect.catchEager(() => Effect.succeed(undefined)),
  );

/** Read the token, creating it (and its directory) when absent. */
export const ensureAuthToken = Effect.fn("ensureAuthToken")(function* (
  fs: FileSystem.FileSystem,
  paths: PathsShape,
) {
  const existing = yield* readAuthToken(fs, paths);
  if (existing !== undefined) return existing;
  yield* ensureSakuDirs(fs, paths);
  const token = randomBytes(32).toString("hex");
  yield* fs.writeFileString(paths.authPath, `${token}\n`, { mode: 0o600 });
  yield* fs.chmod(paths.authPath, 0o600);
  return token;
});
