/**
 * The env provisioner seam (provisioner.ts): the hub's only interface to
 * the thread's hands (ADR 0003).
 *
 * The hub calls `ensure` before the first mutating command of a thread
 * whose env is not `ready`; the provisioner makes the env answer
 * (resume/start the Box, wait for the env daemon's health check) or fails,
 * which flips the thread's env axis to `error`. `release` runs on thread
 * deletion (stop the Box).
 *
 * M2 ships the local-only provisioner: local-mode threads are served by the
 * local env daemon and are always ready; sandbox threads fail loudly —
 * Box provisioning lands with the env daemon in M3. The Box API key and
 * the `EnvHandle` hand-off are M3's business; the seam is the contract.
 */

import { Effect } from "effect";

import { HubError } from "./hub-error.ts";
import type { HubRecord } from "./registry.ts";

export interface EnvProvisioner {
  /** Make the thread's env answer; fails → the hub sets the env axis to `error`. */
  readonly ensure: (thread: HubRecord) => Effect.Effect<void, HubError>;
  /** Release the env (stop the Box, drop the handle). Best-effort. */
  readonly release: (threadId: string) => Effect.Effect<void, HubError>;
}

/** M2: local envs are always ready; sandbox provisioning arrives with M3. */
export const localOnlyProvisioner: EnvProvisioner = {
  ensure: (thread) =>
    thread.mode === "sandbox"
      ? Effect.fail(
          new HubError({
            message: "sandbox envs are not provisioned yet (the env daemon lands in M3)",
          }),
        )
      : Effect.void,
  release: () => Effect.void,
};
