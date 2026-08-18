/**
 * Model catalog (model-catalog.ts): the threads' shared view of pi's models,
 * provided as a service (`ModelCatalogLive` — the daemon's only provider).
 *
 * v1 reads what the user already has:
 * - `auth.json` — provider credentials (read-only CredentialStore; writes
 *   would be daemon-owned, out of v1 scope)
 * - `models.json` — custom providers (api keys, base urls, model lists) and
 *   overlays over builtin providers
 * - the opencode-go provider (`@earendil-works/pi-ai/providers/opencode-go`)
 *   — the only builtin provider saku registers; everything else (openai,
 *   anthropic, gemini, …) is deliberately out of scope until a model picker
 *   exists
 *
 * No extension providers, no network model refresh. The env override
 * `PI_CODING_AGENT_DIR` redirects auth.json/models.json.
 */

import { Context, Effect, FileSystem, Layer, Result, Schema } from "effect";
import { createProvider } from "@earendil-works/pi-ai";
import type {
  Api,
  ApiKeyAuth,
  ApiKeyCredential,
  AuthCheck,
  AuthInteraction,
  AuthResult,
  CreateProviderOptions,
  Model,
  Provider,
  ProviderAuth,
  ProviderStreams,
} from "@earendil-works/pi-ai";
import { getApiProvider, registerBuiltInApiProviders } from "@earendil-works/pi-ai/compat";

import { isNotFound } from "@saku/store";
import { Paths, PathsTest } from "./paths.ts";
import { createModelCatalog } from "./model-catalog-factory.ts";
import type { ModelCatalogApi } from "./model-catalog-factory.ts";
import { AuthJsonCredentialStore } from "./auth-json.ts";
import { ModelsJsonError } from "./models-json-error.ts";
import {
  getMissingConfigValueEnvVarNames,
  isCommandConfigValue,
  resolveConfigValue,
  resolveHeaders,
} from "./config-value.ts";

export { ModelsJsonError } from "./models-json-error.ts";
export type { ModelCatalogApi } from "./model-catalog-factory.ts";

const ModelsJsonModelFields = {
  api: Schema.optional(Schema.String),
  baseUrl: Schema.optional(Schema.String),
  contextWindow: Schema.optional(Schema.Number),
  cost: Schema.optional(
    Schema.Struct({
      cacheRead: Schema.optional(Schema.Number),
      cacheWrite: Schema.optional(Schema.Number),
      input: Schema.optional(Schema.Number),
      output: Schema.optional(Schema.Number),
    }),
  ),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  input: Schema.optional(Schema.Array(Schema.Literals(["text", "image"]))),
  maxTokens: Schema.optional(Schema.Number),
  name: Schema.optional(Schema.String),
  reasoning: Schema.optional(Schema.Boolean),
  samplingParams: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
};

const ModelsJsonModel = Schema.Struct({ id: Schema.String, ...ModelsJsonModelFields });

type ModelsJsonModel = Schema.Schema.Type<typeof ModelsJsonModel>;

const ModelsJsonProviderConfig = Schema.Struct({
  api: Schema.optional(Schema.String),
  apiKey: Schema.optional(Schema.String),
  baseUrl: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  // Overrides apply to a builtin provider's existing models, so id is not part of them.
  modelOverrides: Schema.optional(
    Schema.Record(Schema.String, Schema.Struct(ModelsJsonModelFields)),
  ),
  models: Schema.optional(Schema.Array(ModelsJsonModel)),
  name: Schema.optional(Schema.String),
});

type ModelsJsonProviderConfig = Schema.Schema.Type<typeof ModelsJsonProviderConfig>;

const ModelsJsonSchema = Schema.Struct({
  providers: Schema.Record(Schema.String, ModelsJsonProviderConfig),
});

const DECODE_MODELS_JSON = Schema.decodeUnknownSync(ModelsJsonSchema);

const DEFAULT_COST = { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 };

const modelFromJson = Effect.fn("modelFromJson")(function* (
  providerId: string,
  definition: ModelsJsonModel,
  config: ModelsJsonProviderConfig,
  env: Record<string, string>,
) {
  const api = definition.api ?? config.api;
  if (api === undefined) {
    return yield* Effect.fail(
      new ModelsJsonError({
        message: `Provider ${providerId}, model ${definition.id}: no "api" specified. Set at provider or model level.`,
      }),
    );
  }
  const baseUrl = definition.baseUrl ?? config.baseUrl;
  if (baseUrl === undefined) {
    return yield* Effect.fail(
      new ModelsJsonError({
        message: `Provider ${providerId}: "baseUrl" is required when defining custom models.`,
      }),
    );
  }
  const headers = resolveHeaders(definition.headers, env);
  const built: Model<Api> = {
    api,
    baseUrl,
    contextWindow: definition.contextWindow ?? 128_000,
    cost: {
      ...DEFAULT_COST,
      cacheRead: definition.cost?.cacheRead ?? DEFAULT_COST.cacheRead,
      cacheWrite: definition.cost?.cacheWrite ?? DEFAULT_COST.cacheWrite,
      input: definition.cost?.input ?? DEFAULT_COST.input,
      output: definition.cost?.output ?? DEFAULT_COST.output,
    },
    id: definition.id,
    input: [...(definition.input ?? ["text"])],
    maxTokens: definition.maxTokens ?? 16_384,
    name: definition.name ?? definition.id,
    provider: providerId,
    reasoning: definition.reasoning ?? false,
  };
  if (headers !== undefined) {
    built.headers = headers;
  }
  if (definition.samplingParams !== undefined) {
    built.samplingParams = definition.samplingParams;
  }
  return built;
});

const streamsFor = Effect.fn("streamsFor")(function* (models: readonly Model<Api>[]) {
  const streams: Partial<Record<Api, ProviderStreams>> = {};
  for (const model of models) {
    if (streams[model.api] !== undefined) {
      continue;
    }
    const implementation = getApiProvider(model.api);
    if (implementation === undefined) {
      return yield* Effect.fail(
        new ModelsJsonError({
          message: `Provider ${model.provider}, model ${model.id}: no stream implementation for api "${model.api}".`,
        }),
      );
    }
    streams[model.api] = {
      stream: implementation.stream,
      streamSimple: implementation.streamSimple,
    };
  }
  return streams;
});

/** Availability check: a stored credential wins, otherwise the configured value counts when resolvable (commands count as configured — checks stay side-effect free). */
const apiKeyCheckOf = (
  input: { readonly credential?: ApiKeyCredential },
  rawKey: string | undefined,
  env: Record<string, string>,
): AuthCheck | undefined => {
  const storedKey = input.credential?.key;
  if (storedKey !== undefined && storedKey !== "") {
    return { source: "stored credential", type: "api_key" as const };
  }
  if (rawKey !== undefined) {
    // Commands are not executed during checks (listing must stay
    // side-effect free); a configured command counts as configured.
    if (isCommandConfigValue(rawKey)) {
      return { source: "configured API key", type: "api_key" as const };
    }
    if (getMissingConfigValueEnvVarNames(rawKey, env).length === 0) {
      return { source: "configured API key", type: "api_key" as const };
    }
  }
  return undefined satisfies undefined;
};

/** Auth resolution: the stored credential (with its provider env) or the configured value resolved against the daemon env. */
const apiKeyResolveOf = (
  input: { readonly credential?: ApiKeyCredential },
  rawKey: string | undefined,
  env: Record<string, string>,
): AuthResult | undefined => {
  const stored = input.credential;
  if (stored?.key !== undefined && stored.key !== "") {
    const resolution: AuthResult = {
      auth: { apiKey: stored.key },
      source: "stored credential",
    };
    if (stored.env !== undefined) {
      resolution.env = stored.env;
    }
    return resolution;
  }
  if (rawKey !== undefined) {
    const key = resolveConfigValue(rawKey, env);
    if (key !== undefined) {
      return { auth: { apiKey: key }, source: "configured API key" };
    }
  }
  return undefined satisfies undefined;
};

/**
 * ApiKeyAuth for models.json custom providers: a stored credential wins,
 * otherwise the configured value resolves against the daemon's environment
 * (`$VAR` interpolation, `!command` execution — see config-value.ts).
 */
const apiKeyAuthFor = (
  providerId: string,
  config: ModelsJsonProviderConfig,
  env: Record<string, string>,
): ApiKeyAuth => {
  const rawKey = config.apiKey;
  return {
    check: async (input) => await Promise.resolve(apiKeyCheckOf(input, rawKey, env)),
    login: async (interaction: AuthInteraction) => ({
      key: await interaction.prompt({
        message: `Enter API key for ${providerId}`,
        type: "secret",
      }),
      type: "api_key" as const,
    }),
    name: "API key",
    resolve: async (input) => await Promise.resolve(apiKeyResolveOf(input, rawKey, env)),
  };
};

/** Apply models.json per-model overrides to an overlay provider's model list (id-matched, in place). */
const applyModelOverrides = (models: Model<Api>[], config: ModelsJsonProviderConfig) => {
  for (const [modelId, override] of Object.entries(config.modelOverrides ?? {})) {
    const index = models.findIndex((model) => model.id === modelId);
    const current = models[index];
    if (index === -1 || current === undefined) {
      continue;
    }
    const next = {
      ...current,
      baseUrl: override.baseUrl ?? current.baseUrl,
      contextWindow: override.contextWindow ?? current.contextWindow,
      cost: {
        ...current.cost,
        cacheRead: override.cost?.cacheRead ?? current.cost.cacheRead,
        cacheWrite: override.cost?.cacheWrite ?? current.cost.cacheWrite,
        input: override.cost?.input ?? current.cost.input,
        output: override.cost?.output ?? current.cost.output,
      },
      input: [...(override.input ?? current.input)],
      maxTokens: override.maxTokens ?? current.maxTokens,
      name: override.name ?? current.name,
      reasoning: override.reasoning ?? current.reasoning,
    };
    if (override.headers !== undefined) {
      next.headers = override.headers;
    }
    models[index] = next;
  }
};

const loadModelsJsonFrom = Effect.fn("loadModelsJsonFrom")(function* (
  fs: FileSystem.FileSystem,
  path: string,
) {
  const raw = yield* fs.readFileString(path).pipe(
    Effect.catch((error) => {
      // No models.json is the default install; anything else is worth knowing.
      if (isNotFound(error)) {
        return Effect.succeed(undefined satisfies undefined);
      }
      return Effect.logWarning(`failed to read models.json: ${String(error)}`).pipe(
        Effect.as(undefined satisfies undefined),
      );
    }),
  );
  if (raw === undefined) {
    return { providers: {} };
  }
  const parsed = Result.try(() => DECODE_MODELS_JSON(raw));
  if (Result.isFailure(parsed)) {
    yield* Effect.logWarning(`models.json is not valid JSON: ${String(parsed.failure)}`);
    return { providers: {} };
  }
  return parsed.success;
});

/** A models.json provider that is not a builtin: full construction. */
const buildCustomProvider = Effect.fn("buildCustomProvider")(function* (
  providerId: string,
  config: ModelsJsonProviderConfig,
  env: Record<string, string>,
) {
  const models: Model<Api>[] = [];
  for (const definition of config.models ?? []) {
    models.push(yield* modelFromJson(providerId, definition, config, env));
  }
  if (models.length === 0) {
    return yield* Effect.fail(new ModelsJsonError({ message: "no models defined" }));
  }
  const auth: ProviderAuth = { apiKey: apiKeyAuthFor(providerId, config, env) };
  const headers = resolveHeaders(config.headers, env);
  const streams = yield* streamsFor(models);
  const options: CreateProviderOptions = {
    api: streams,
    auth,
    id: providerId,
    models,
    name: config.name ?? providerId,
  };
  if (config.baseUrl !== undefined) {
    options.baseUrl = config.baseUrl;
  }
  if (headers !== undefined) {
    options.headers = headers;
  }
  return createProvider(options);
});

/**
 * models.json overlay over a builtin provider: base url, headers, model list
 * replacement, and per-model overrides. The provider's own auth is reused.
 */
const overlayBuiltinProvider = Effect.fn("overlayBuiltinProvider")(function* (
  providerId: string,
  base: Provider,
  config: ModelsJsonProviderConfig,
  env: Record<string, string>,
) {
  const resolvedHeaders = resolveHeaders(config.headers, env);
  const baseModels = base.getModels();
  const models = baseModels.map((model) => {
    const next = { ...model, baseUrl: config.baseUrl ?? model.baseUrl };
    if (resolvedHeaders !== undefined) {
      next.headers = resolvedHeaders;
    }
    return next;
  });
  for (const definition of config.models ?? []) {
    const existingIndex = models.findIndex((model) => model.id === definition.id);
    const built = yield* modelFromJson(providerId, definition, config, env);
    if (existingIndex === -1) {
      models.push(built);
    } else {
      models[existingIndex] = built;
    }
  }
  applyModelOverrides(models, config);
  const changed =
    config.baseUrl !== undefined ||
    resolvedHeaders !== undefined ||
    (config.models?.length ?? 0) > 0 ||
    Object.keys(config.modelOverrides ?? {}).length > 0;
  if (!changed) {
    return undefined satisfies undefined;
  }
  const streams = yield* streamsFor(models);
  const options: CreateProviderOptions = {
    api: streams,
    auth: base.auth,
    id: providerId,
    models,
    name: config.name ?? base.name,
  };
  if (config.baseUrl !== undefined) {
    options.baseUrl = config.baseUrl;
  }
  if (resolvedHeaders !== undefined) {
    options.headers = resolvedHeaders;
  }
  return createProvider(options);
});

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
      const env: Record<string, string> = {};
      for (const [name, value] of Object.entries(process.env)) {
        if (value !== undefined) {
          env[name] = value;
        }
      }
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
