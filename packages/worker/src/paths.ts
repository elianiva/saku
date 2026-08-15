/**
 * Paths: the on-disk layout saku owns, as a service (paths.ts).
 *
 * ```
 * ~/.saku/                    <- SAKU_HOME overrides
 *   worker.url                the daemon's WebSocket URL (127.0.0.1:port)
 *   auth                      32-byte hex token, 0600 (created on first boot)
 *   worker.log                daemon log
 *   threads/<id>/
 *     thread.json             registry record (name, cwd, mode, sessionId)
 *     trail/                  the thread session's KvStore (meta + log/*)
 *   projects.json             the added-projects list (session window scope)
 * ```
 *
 * The two roots are `Config` values — `SAKU_HOME` (default `~/.saku`) and
 * `PI_CODING_AGENT_DIR` (default `~/.pi/agent`) — so the environment is
 * read declaratively when `PathsLive` is built, instead of every caller
 * touching `process.env`. Tests provide `PathsTest` (a temp-dir layout,
 * removed when the run's scope closes) — no env mutation.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Config, Context, Effect, FileSystem, Layer } from "effect";

/** The resolved on-disk layout; every path is absolute. */
export interface PathsShape {
  readonly sakuDir: string;
  readonly workerSocketPath: string;
  /** Where the daemon publishes its WebSocket URL (127.0.0.1:port). */
  readonly workerUrlPath: string;
  readonly authPath: string;
  readonly workerLogPath: string;
  readonly threadsDir: string;
  /** The added-projects list (the session window's scope; CONTEXT.md: Project). */
  readonly projectsPath: string;
  /** Per-thread directory (removed wholesale on registry delete). */
  readonly threadDir: (threadId: string) => string;
  /** The thread session's KvStore root (meta + log/* under it, see do-session.ts). */
  readonly threadTrailRoot: (threadId: string) => string;
  /** pi's agent dir (~/.pi/agent, overridable via PI_CODING_AGENT_DIR). */
  readonly agentDir: string;
  readonly authJsonPath: string;
  readonly modelsJsonPath: string;
}

/** The on-disk layout, provided by `PathsLive`. */
export class Paths extends Context.Service<Paths, PathsShape>()("Paths") {}

/**
 * Derive the full layout from the two roots (pure; inputs should be
 * absolute). `PathsLive` wires the `Config` values into this; `PathsTest`
 * derives its temp-dir layout from it.
 */
const makePaths = (sakuHome: string, agentDir: string): PathsShape => ({
  sakuDir: sakuHome,
  workerSocketPath: join(sakuHome, "worker.sock"),
  workerUrlPath: join(sakuHome, "worker.url"),
  authPath: join(sakuHome, "auth"),
  workerLogPath: join(sakuHome, "worker.log"),
  threadsDir: join(sakuHome, "threads"),
  projectsPath: join(sakuHome, "projects.json"),
  threadDir: (threadId) => join(sakuHome, "threads", threadId),
  threadTrailRoot: (threadId) => join(sakuHome, "threads", threadId, "trail"),
  agentDir,
  authJsonPath: join(agentDir, "auth.json"),
  modelsJsonPath: join(agentDir, "models.json"),
});

// `Config` reads the process environment through the default provider.
// Both roots fall back to the user's home; an empty string counts as unset
// (Effect's env semantics), so `SAKU_HOME=""` no longer resolves to the
// current directory.
const sakuHome = Config.string("SAKU_HOME").pipe(
  Config.withDefault(join(homedir(), ".saku")),
  Config.map(resolve),
);

const agentDir = Config.string("PI_CODING_AGENT_DIR").pipe(
  Config.withDefault(join(homedir(), ".pi", "agent")),
  Config.map(resolve),
);

/**
 * The live layout. Both roots have defaults, so the config cannot fail; a
 * ConfigError here is a defect, not a recoverable failure.
 */
export const PathsLive: Layer.Layer<Paths, never> = Layer.effect(
  Paths,
  Effect.gen(function* () {
    const saku = yield* sakuHome;
    const agent = yield* agentDir;
    return Paths.of(makePaths(saku, agent));
  }).pipe(Effect.orDie),
);

/**
 * The test layout. With no arguments, a fresh temp home is created when
 * the layer is built and removed when its scope closes. Pass `home` to pin
 * an explicit layout (the caller owns its lifecycle — the registry
 * round-trip test reuses one home across two boots).
 */
export const PathsTest = (home?: string) =>
  Layer.effect(
    Paths,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      // A temp-dir failure in tests is a defect, not a recoverable failure
      // (the same posture as PathsLive's config errors).
      const sakuHome =
        home ?? (yield* fs.makeTempDirectoryScoped({ prefix: "saku" }).pipe(Effect.orDie));
      return Paths.of(makePaths(sakuHome, join(sakuHome, ".pi", "agent")));
    }),
  );
