/**
 * The static env provisioner: a deployment-wide configured env daemon for
 * development and self-hosted celld setups. Every thread uses the same
 * connection (`SAKU_ENV_URL` + `SAKU_ENV_TOKEN`); there is no remote-machine
 * lifecycle and idle-stop releases nothing.
 */

import { Effect } from "effect";
import { HubError } from "@saku/hub/core";

import type { DeploymentEnv } from "./env.ts";

export const staticProvisioner = (env: DeploymentEnv) => ({
  ensure: Effect.fn("ensure")(function* ensure() {
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
    return { handle: { token, url }, remoteMachineId: null };
  }),
  release: () => Effect.void,
});
