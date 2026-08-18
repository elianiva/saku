/**
 * The shared catalog construction (model-catalog-factory.ts): the one
 * place the thread-facing model catalog is built — the opencode-go
 * provider, the `SAKU_FAKE_MODEL` scripted fixture, and the
 * `ModelCatalogApi` view — parameterized by the auth source (the
 * daemon's credential store vs a deployment's auth context).
 *
 * Node-clean (no node: imports): the deployment's thread DO imports it
 * through `@saku/worker/isolate`, where the module graph must stay
 * isolate-safe (fake-provider.ts is the same kind of module).
 */

import { Effect } from "effect";
import { createModels } from "@earendil-works/pi-ai";
import type {
  Api,
  AuthContext,
  CredentialStore,
  Model,
  MutableModels,
} from "@earendil-works/pi-ai";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import type { WireModelInfo } from "@saku/wire";

import { fakeProvider } from "./fake-provider.ts";

/** The threads' shared model runtime: builtins + models.json, auth-aware. */
export interface ModelCatalogApi {
  /** The shared `MutableModels` collection (also feeds core's compaction helpers). */
  readonly models: MutableModels;
  /** Models whose providers have complete auth configuration. */
  readonly available: () => Effect.Effect<readonly Model<Api>[]>;
  readonly hasAuth: (providerId: string) => Effect.Effect<boolean>;
  readonly getModel: (providerId: string, modelId: string) => Model<Api> | undefined;
  readonly toWireInfo: (model: Model<Api>) => WireModelInfo;
}

/** The auth source the catalog's models resolve credentials from. */
export type ModelCatalogAuthSource =
  | { readonly credentials: CredentialStore }
  | { readonly authContext: AuthContext };

/** Whether the scripted provider is on: `SAKU_FAKE_MODEL` set and non-empty (the one check). */
const fakeModelEnabled = (env: Readonly<{ SAKU_FAKE_MODEL?: string }>) =>
  env.SAKU_FAKE_MODEL !== undefined && env.SAKU_FAKE_MODEL !== "";

/**
 * Build the thread-facing catalog: the opencode-go provider (the only
 * builtin provider saku registers) plus the scripted fixture behind
 * `SAKU_FAKE_MODEL` (a canned stream, no paid model needed to exercise
 * the full loop), over the caller's auth source. The daemon extends the
 * result with models.json providers; a deployment has no filesystem and
 * uses the catalog as-is.
 */
export const createModelCatalog = (options: {
  /** The auth source: the daemon's credential store or the deployment's auth context. */
  readonly auth: ModelCatalogAuthSource;
  /** The env the `SAKU_FAKE_MODEL` switch reads (process env or the deployment's bindings). */
  readonly env: Readonly<{ SAKU_FAKE_MODEL?: string }>;
}): ModelCatalogApi => {
  const models = createModels(
    "credentials" in options.auth
      ? { credentials: options.auth.credentials }
      : { authContext: options.auth.authContext },
  );

  // The one builtin provider: opencode-go (the local OpenCode gateway).
  // The fake provider rides SAKU_FAKE_MODEL; models.json custom providers
  // are user-defined and unaffected.
  models.setProvider(opencodeGoProvider());

  // The scripted provider (dev fixture): a canned stream that answers
  // every prompt — no paid model needed to exercise the full loop.
  if (fakeModelEnabled(options.env)) {
    models.setProvider(fakeProvider());
  }

  return {
    available: () => Effect.tryPromise(() => models.getAvailable()),
    getModel: (providerId, modelId) => models.getModel(providerId, modelId),
    hasAuth: (providerId) =>
      Effect.tryPromise(() => models.checkAuth(providerId)).pipe(
        Effect.map((check) => check !== undefined),
        Effect.catch(() => Effect.succeed(false)),
      ),
    models,
    toWireInfo: (model) => ({
      contextWindow: model.contextWindow,
      id: model.id,
      provider: model.provider,
      reasoning: model.reasoning,
    }),
  };
};
