/**
 * Paths tests (paths.test.ts): `PathsLive`'s config contract — the roots
 * come from `SAKU_HOME`/`PI_CODING_AGENT_DIR` (via an explicit
 * `ConfigProvider`, never the live process env), fall back to the user's
 * home, and resolve relative values. The layout derivations themselves are
 * pure and are exercised through every consumer test (`PathsTest`).
 */

import { homedir } from "node:os";
import path from "node:path";

import { ConfigProvider, Effect } from "effect";
import { describe, expect, it } from "vitest";

import { Paths, PathsLive } from "../src/paths.ts";

const resolve = (env: Record<string, string>) =>
  Effect.runSync(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })))(
      Effect.provide(PathsLive)(Paths),
    ),
  );

describe("PathsLive", () => {
  it("defaults to ~/.saku and ~/.pi/agent when the vars are unset", () => {
    const paths = resolve({});
    expect(paths.sakuDir).toBe(path.join(homedir(), ".saku"));
    expect(paths.agentDir).toBe(path.join(homedir(), ".pi", "agent"));
    expect(paths.threadTrailRoot("abc")).toBe(
      path.join(homedir(), ".saku", "threads", "abc", "trail"),
    );
  });

  it("honors SAKU_HOME and PI_CODING_AGENT_DIR", () => {
    const paths = resolve({ PI_CODING_AGENT_DIR: "/tmp/pi-a", SAKU_HOME: "/tmp/home-a" });
    expect(paths.sakuDir).toBe("/tmp/home-a");
    expect(paths.authPath).toBe("/tmp/home-a/auth");
    expect(paths.threadsDir).toBe("/tmp/home-a/threads");
    expect(paths.agentDir).toBe("/tmp/pi-a");
    expect(paths.modelsJsonPath).toBe("/tmp/pi-a/models.json");
  });

  it("resolves relative roots against the cwd", () => {
    const paths = resolve({ SAKU_HOME: "rel/home" });
    expect(paths.sakuDir).toBe(path.join(process.cwd(), "rel", "home"));
  });

  it("treats an empty SAKU_HOME as unset", () => {
    const paths = resolve({ SAKU_HOME: "" });
    expect(paths.sakuDir).toBe(path.join(homedir(), ".saku"));
  });
});
