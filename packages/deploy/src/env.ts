/**
 * The deployment's typed bindings (env.ts): everything a Durable Object
 * or the entry worker reads off its `env` — the two DO namespaces, the
 * deployment secret, the Box API key, and the deployment's vars.
 *
 * The alchemy program (alchemy.run.ts) declares exactly these bindings;
 * the celld twin declares them in `celld/wrangler.json`. `InferEnv` from
 * alchemy would give the same shape — this interface is the explicit
 * contract both deployment targets share, so the entry code never
 * imports alchemy at runtime.
 */

/** The vars a deployment may set (all optional; the defaults in the stack). */
export interface DeploymentVars {
  /**
   * "box" (default — incomplete, ADR 0008), "static" (dev/celld shape),
   * or "freestyle" (the intended provider, ADR 0008 — the backend is in
   * preparation, so the hub fails loudly until it lands).
   */
  readonly SAKU_ENV_PROVISIONER?: string;
  /** Static provisioner: the env daemon's endpoint + token. */
  readonly SAKU_ENV_URL?: string;
  readonly SAKU_ENV_TOKEN?: string;
  /** The idle-stop window, milliseconds ("300000" default). */
  readonly SAKU_IDLE_STOP_MS?: string;
  /** Non-empty → the catalog adds a scripted provider ("saku-fake/test"). */
  readonly SAKU_FAKE_MODEL?: string;
}

/** The deployment's env: namespaces + secret + vars. */
export interface DeploymentEnv extends DeploymentVars {
  readonly HUB: DurableObjectNamespace;
  readonly THREAD: DurableObjectNamespace;
  /** The deployment secret consoles present in `hello` (v1 auth). */
  readonly DEPLOYMENT_SECRET: string;
  /** The Box API key (ascii.dev); empty for static-provisioner deploys.
   * Box is incomplete (ADR 0008) — kept for parity until Freestyle lands. */
  readonly BOX_API_KEY: string;
  /** The Freestyle API key (freestyle.sh); unused until the freestyle
   * provisioner backend lands (ADR 0008). */
  readonly FREESTYLE_API_KEY: string;
}

/** The hub DO's instance name (the single control-plane instance). */
export const HUB_INSTANCE = "hub";

/** Resolve a deployment var with a default (workerd has no process.env). */
export const varOrDefault = (
  env: DeploymentEnv,
  name: keyof DeploymentVars,
  fallback: string,
) => {
  const value = env[name];
  return typeof value === "string" && value.length > 0 ? value : fallback;
};
