/**
 * The static env provisioner (static-provisioner.ts): a Box-less
 * deployment mode for development and self-hosted celld setups — every
 * thread's env is one configured env daemon (SAKU_ENV_URL +
 * SAKU_ENV_TOKEN), and idle-stop releases nothing (a local daemon never
 * stops, ADR 0003).
 *
 * The Box provisioner (makeProvisioner) remains the selectable default
 * but is incomplete (ADR 0008); the intended production provider is
 * Freestyle (`SAKU_ENV_PROVISIONER=freestyle` — the backend is in
 * preparation, so the hub fails loudly until it lands).
 * `SAKU_ENV_PROVISIONER=static` opts the deployment into this mode.
 */

import { Effect, Option } from "effect";
import { HubError, type EnvProvisioner } from "@saku/hub/core";
import type { EnvHandle } from "@saku/env";

import type { DeploymentEnv } from "./env.ts";

export const staticProvisioner = (env: DeploymentEnv) => ({
  ensure: Effect.fn("ensure")(function* (_thread, _handle) {
    const url = env.SAKU_ENV_URL;
    const token = env.SAKU_ENV_TOKEN;
    if (url === undefined || url.length === 0 || token === undefined || token.length === 0) {
      return yield* Effect.fail(
        new HubError({
          kind: "provisioner",
          message: "static provisioner requires SAKU_ENV_URL and SAKU_ENV_TOKEN",
        }),
      );
    }
    const handle: EnvHandle = { url, token, boxId: null };
    return Option.some(handle);
  }),
  release: () => Effect.void,
});
