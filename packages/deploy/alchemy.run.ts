/**
 * The saku deployment program (alchemy.run.ts): one alchemy stack
 * declaring the Worker, its two Durable Object namespaces, the
 * deployment secret, and the deployment's secrets and vars (ADR 0002).
 *
 * `bun alchemy deploy` targets Cloudflare; the same program's bindings
 * are mirrored by hand in `celld/wrangler.jsonc` for self-hosted celld
 * deployments (the entry code itself never imports alchemy at runtime —
 * it is plain workerd).
 *
 * The stack is exported as `makeStack(options)` so the integration tests
 * deploy a variant (static env provisioner, scripted model, test secret)
 * against the same code.
 */

import { Random } from "alchemy";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import type { SakuHubDO, SakuThreadDO } from "./src/worker.ts";

export interface StackOptions {
  /** The deployment secret (default: a persistent random value). */
  readonly secret?: Redacted.Redacted<string>;
  /** The Box API key (default: the BOX_API_KEY secret). */
  readonly boxApiKey?: Redacted.Redacted<string>;
  /** "box" (default) or "static" (a configured env daemon, dev/celld). */
  readonly provisioner?: "box" | "static";
  /** Static provisioner: the env daemon's endpoint + token. */
  readonly envUrl?: string;
  readonly envToken?: string;
  /** Idle-stop window in milliseconds (default 300000). */
  readonly idleStopMs?: number;
  /** Add the scripted provider (dev deployments, integration tests). */
  readonly fakeModel?: boolean;
}

export const makeStack = (options: StackOptions = {}) =>
  Alchemy.Stack(
    "Saku",
    {
      providers: Cloudflare.providers(),
      state: Cloudflare.state(),
    },
    Effect.gen(function* () {
      // The deployment secret: a persistent random value minted once, or
      // the caller's own (the tests pass a fixed test secret).
      const secret = options.secret ?? (yield* Random("SakuDeploymentSecret")).text;
      const worker = yield* Cloudflare.Worker("saku", {
        main: "./src/worker.ts",
        env: {
          HUB: Cloudflare.DurableObject<SakuHubDO>("HUB", { className: "SakuHubDO" }),
          THREAD: Cloudflare.DurableObject<SakuThreadDO>("THREAD", {
            className: "SakuThreadDO",
          }),
          DEPLOYMENT_SECRET: secret,
          BOX_API_KEY:
            options.boxApiKey ??
            Config.redacted("BOX_API_KEY").pipe(Config.withDefault(Redacted.make(""))),
          SAKU_ENV_PROVISIONER: Config.string("SAKU_ENV_PROVISIONER").pipe(
            Config.withDefault(options.provisioner ?? "box"),
          ),
          SAKU_ENV_URL: Config.string("SAKU_ENV_URL").pipe(
            Config.withDefault(options.envUrl ?? ""),
          ),
          SAKU_ENV_TOKEN: Config.string("SAKU_ENV_TOKEN").pipe(
            Config.withDefault(options.envToken ?? ""),
          ),
          SAKU_IDLE_STOP_MS: Config.string("SAKU_IDLE_STOP_MS").pipe(
            Config.withDefault(String(options.idleStopMs ?? 300_000)),
          ),
          SAKU_FAKE_MODEL: Config.string("SAKU_FAKE_MODEL").pipe(
            Config.withDefault(options.fakeModel === true ? "1" : ""),
          ),
        },
      });
      return { url: worker.url };
    }),
  );

export default makeStack();
