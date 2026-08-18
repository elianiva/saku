/**
 * Model catalog (model-catalog.ts): the threads' shared view of pi's models,
 * provided as a service (`ModelCatalogLive` — the daemon's only provider).
 *
 * v1 reads what the user already has:
 * - `auth.json` — provider credentials (read-only CredentialStore; writes
 *   would be daemon-owned, out of v1 scope)
 * - `models.json` — custom providers (api keys, base urls, model lists) and
 *   overlays over builtin providers (parsed by `models-json.ts`)
 * - the opencode-go provider (`@earendil-works/pi-ai/providers/opencode-go`)
 *   — the only builtin provider saku registers; everything else (openai,
 *   anthropic, gemini, …) is deliberately out of scope until a model picker
 *   exists
 *
 * No extension providers, no network model refresh. The env override
 * `PI_CODING_AGENT_DIR` redirects auth.json/models.json.
 */

import { Context, Effect, FileSystem, Layer } from "effect";
import { registerBuiltInApiProviders } from "@earendil-works/pi-ai/compat";

import { Paths, PathsTest } from "./paths.ts";
import { createModelCatalog } from "./model-catalog-factory.ts";
import type { ModelCatalogApi } from "./model-catalog-factory.ts";
import { AuthJsonCredentialStore } from "./auth-json.ts";
import { buildCustomProvider, loadModelsJsonFrom, overlayBuiltinProvider } from "./models-json.ts";

export { ModelsJsonError } from "./models-json-error.ts";
export type { ModelCatalogApi } from "./model-catalog-factory.ts";

export interface CatalogOptions {
  authPath?: string;
  modelsPath?: string;
}

/** The threads' shared model runtime: builtins + models.json, auth-aware. */
export class ModelCatalog extends Context.Service<ModelCatalog, ModelCatalogApi>()(
  "ModelCatalog",
) {}

/** Build the catalog from auth.json, models.json, and pi's builtin providers. */
export const ModelCatalogLive = (options: CatalogOptions = {}) =>
  Layer.effect(
    ModelCatalog,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Paths;
      // The daemon's own environment resolves models.json `$VAR`/`!cmd` values.
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      registerBuiltInApiProviders();
      const credentials = yield* AuthJsonCredentialStore.load(
        options.authPath ?? paths.authJsonPath,
        fs,
      );
      // The shared construction: opencode-go + the scripted fixture over
      // the auth source (model-catalog-factory.ts, the one SAKU_FAKE_MODEL
      // check). models.json providers are added below.
      const catalog = createModelCatalog({ auth: { credentials }, env });

      const config = yield* loadModelsJsonFrom(fs, options.modelsPath ?? paths.modelsJsonPath);
      for (const [providerId, providerConfig] of Object.entries(config.providers)) {
        const base = catalog.models.getProvider(providerId);
        const outcome =
          base === undefined
            ? buildCustomProvider(providerId, providerConfig, env)
            : overlayBuiltinProvider(providerId, base, providerConfig, env);
        yield* outcome.pipe(
          Effect.flatMap((provider) => {
            if (provider !== undefined) {
              catalog.models.setProvider(provider);
            }
            return Effect.void;
          }),
          Effect.catch((error) =>
            Effect.logWarning(`models.json: skipping provider "${providerId}": ${String(error)}`),
          ),
        );
      }

      return ModelCatalog.of(catalog);
    }),
  );

/**
 * The test catalog: `ModelCatalogLive` over `PathsTest`'s temp layout —
 * no auth.json, no models.json, so the builtin providers only (auth
 * checks resolve against the daemon's env, as in production).
 */
export const ModelCatalogTest = (home?: string) =>
  ModelCatalogLive().pipe(Layer.provide(PathsTest(home)));
