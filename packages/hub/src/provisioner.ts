/**
 * The env provisioner seam: the hub's provider-neutral lifecycle boundary.
 * Concrete deployment paths implement it for a local/static daemon or a
 * lifecycle-managed remote machine such as Box or Freestyle.
 */

import type { EnvHandle } from "@saku/env";
import type { Effect } from "effect";

import type { HubError } from "./hub-error.ts";
import type { HubRecord } from "./registry.ts";

/** The two hub-owned values that make an env usable by a worker. */
export interface EnvProvisioning {
  /** The provider resource identity; null for local/static daemon paths. */
  readonly remoteMachineId: string | null;
  /** The connection-only handle passed to the worker; null when no handle exists. */
  readonly handle: EnvHandle | null;
}

/**
 * The control-plane seam selected by deployment wiring. Remote-machine
 * providers implement this through their own adapter; fixed daemons return a
 * connection handle without a machine identity.
 */
export interface EnvProvisioner {
  readonly ensure: (
    thread: HubRecord,
    remoteMachineId: string | null,
    handle: EnvHandle | null,
  ) => Effect.Effect<EnvProvisioning, HubError>;
  readonly release: (
    threadId: string,
    remoteMachineId: string | null,
    handle: EnvHandle | null,
  ) => Effect.Effect<void, HubError>;
}
