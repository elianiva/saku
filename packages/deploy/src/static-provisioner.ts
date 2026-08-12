/**
 * The static env provisioner (static-provisioner.ts): a Box-less
 * deployment mode for development and self-hosted celld setups — every
 * thread's env is one configured env daemon (SAKU_ENV_URL +
 * SAKU_ENV_TOKEN), and idle-stop releases nothing (a local daemon never
 * stops, ADR 0003).
 *
 * The production default remains the Box provisioner (makeProvisioner);
 * `SAKU_ENV_PROVISIONER=static` opts the deployment into this mode.
 */

import { Effect, Option } from "effect";
import { HubError, type EnvProvisioner } from "@saku/hub/core";
import type { EnvHandle } from "@saku/env";

import type { DeploymentEnv } from "./env.ts";

export const staticProvisioner = (env: DeploymentEnv): EnvProvisioner => ({
  ensure: (_thread, _handle) =>
    Effect.gen(function* () {
      const url = env.SAKU_ENV_URL;
      const token = env.SAKU_ENV_TOKEN;
      if (url === undefined || url.length === 0 || token === undefined || token.length === 0) {
        return yield* Effect.fail(
          new HubError({
            message: "static provisioner requires SAKU_ENV_URL and SAKU_ENV_TOKEN",
          }),
        );
      }
      const handle: EnvHandle = { url, token, boxId: null };
      return Option.some(handle);
    }),
  release: () => Effect.void,
});
