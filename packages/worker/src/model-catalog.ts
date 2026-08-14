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

import { dirname } from "node:path";
import { Context, Effect, FileSystem, Layer, Result, Schema } from "effect";
import {
  createProvider,
  type Api,
  type ApiKeyAuth,
  type AuthInteraction,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  type Model,
  type Provider,
  type ProviderAuth,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { getApiProvider, registerBuiltInApiProviders } from "@earendil-works/pi-ai/compat";

import { isNotFound } from "@saku/store";
import { getAuthJsonPath, getModelsJsonPath } from "./paths.ts";
import { createModelCatalog, type ModelCatalogShape } from "./model-catalog-factory.ts";
import {
  getMissingConfigValueEnvVarNames,
  isCommandConfigValue,
  resolveConfigValue,
  resolveHeaders,
} from "./config-value.ts";

export type { ModelCatalogShape } from "./model-catalog-factory.ts";

// ---------------------------------------------------------------------------
// auth.json → CredentialStore
// ---------------------------------------------------------------------------

const AUTH_JSON_FILE_MODE = 0o600;

/** Credential store over pi's auth.json (`Record<providerId, Credential>`). */
class AuthJsonCredentialStore implements CredentialStore {
  private readonly path: string;
  private readonly fs: FileSystem.FileSystem;
  private data: Record<string, Credential>;

  constructor(path: string, fs: FileSystem.FileSystem, initial: Record<string, Credential>) {
    this.path = path;
    this.fs = fs;
    this.data = initial;
  }

  static load(
    path: string,
    fs: FileSystem.FileSystem,
  ): Effect.Effect<AuthJsonCredentialStore, never> {
    return Effect.gen(function* () {
      // Any read failure lands in the Result: missing auth.json is the default
      // install, an unreadable file is worth knowing — both yield an empty store.
      const content = yield* fs.readFileString(path).pipe(
        Effect.map(Result.succeed),
        Effect.catch((error) => Effect.succeed(Result.fail(error))),
      );
      if (Result.isFailure(content)) {
        // A missing auth.json is the default install; anything else is worth
        // knowing (the daemon never mutates credentials in v1, so a malformed
        // file is the user's to fix).
        if (!isNotFound(content.failure)) {
          yield* Effect.logError(`[worker] failed to read auth.json: ${String(content.failure)}`);
        }
        return new AuthJsonCredentialStore(path, fs, {});
      }
      const parsed = Result.try(() => JSON.parse(content.success) as unknown);
      if (Result.isFailure(parsed)) {
        yield* Effect.logError(`[worker] failed to read auth.json: ${String(parsed.failure)}`);
        return new AuthJsonCredentialStore(path, fs, {});
      }
      if (typeof parsed.success === "object" && parsed.success !== null) {
        return new AuthJsonCredentialStore(path, fs, parsed.success as Record<string, Credential>);
      }
      return new AuthJsonCredentialStore(path, fs, {});
    });
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return this.data[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(this.data).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const next = await fn(this.data[providerId]);
    if (next === undefined) return this.data[providerId];
    this.data[providerId] = next;
    // Best-effort write-back: the in-memory credential is already updated;
    // a failed persist must not fail the auth flow.
    void this.persist().catch(() => undefined);
    return next;
  }

  async delete(providerId: string): Promise<void> {
    delete this.data[providerId];
    void this.persist().catch(() => undefined);
  }

  private async persist(): Promise<void> {
    await Effect.runPromise(
      this.fs
        .makeDirectory(dirname(this.path), { recursive: true })
        .pipe(
          Effect.andThen(
            this.fs.writeFileString(this.path, `${JSON.stringify(this.data, null, 2)}\n`, {
              mode: AUTH_JSON_FILE_MODE,
            }),
          ),
        )
        .pipe(Effect.andThen(this.fs.chmod(this.path, AUTH_JSON_FILE_MODE))),
    );
  }
}

// ---------------------------------------------------------------------------
// models.json → providers
// ---------------------------------------------------------------------------

/** A models.json configuration problem (missing api/baseUrl, unknown api implementation, empty provider). */
export class ModelsJsonError extends Schema.TaggedError<ModelsJsonError>()("ModelsJsonError", {
  message: Schema.String,
}) {}

const ModelsJsonModelFields = {
  name: Schema.optional(Schema.String),
  api: Schema.optional(Schema.String),
  baseUrl: Schema.optional(Schema.String),
  reasoning: Schema.optional(Schema.Boolean),
  contextWindow: Schema.optional(Schema.Number),
  maxTokens: Schema.optional(Schema.Number),
  input: Schema.optional(Schema.Array(Schema.Literals(["text", "image"]))),
  cost: Schema.optional(
    Schema.Struct({
      input: Schema.optional(Schema.Number),
      output: Schema.optional(Schema.Number),
      cacheRead: Schema.optional(Schema.Number),
      cacheWrite: Schema.optional(Schema.Number),
    }),
  ),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  samplingParams: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
};

const ModelsJsonModel = Schema.Struct({ id: Schema.String, ...ModelsJsonModelFields });

type ModelsJsonModel = Schema.Schema.Type<typeof ModelsJsonModel>;

const ModelsJsonProviderConfig = Schema.Struct({
  name: Schema.optional(Schema.String),
  baseUrl: Schema.optional(Schema.String),
  apiKey: Schema.optional(Schema.String),
  api: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  models: Schema.optional(Schema.Array(ModelsJsonModel)),
  // Overrides apply to a builtin provider's existing models, so id is not part of them.
  modelOverrides: Schema.optional(
    Schema.Record(Schema.String, Schema.Struct(ModelsJsonModelFields)),
  ),
});

type ModelsJsonProviderConfig = Schema.Schema.Type<typeof ModelsJsonProviderConfig>;

const ModelsJsonSchema = Schema.Struct({
  providers: Schema.Record(Schema.String, ModelsJsonProviderConfig),
});

type ModelsJson = Schema.Schema.Type<typeof ModelsJsonSchema>;

const DECODE_MODELS_JSON = Schema.decodeUnknownSync(ModelsJsonSchema);

const DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const modelFromJson = (
  providerId: string,
  definition: ModelsJsonModel,
  config: ModelsJsonProviderConfig,
  env: Record<string, string>,
): Effect.Effect<Model<Api>, ModelsJsonError> =>
  Effect.gen(function* () {
    const api = (definition.api ?? config.api) as Api | undefined;
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
    return {
      id: definition.id,
      name: definition.name ?? definition.id,
      api,
      provider: providerId,
      baseUrl,
      reasoning: definition.reasoning ?? false,
      input: [...(definition.input ?? ["text"])],
      cost: {
        ...DEFAULT_COST,
        input: definition.cost?.input ?? DEFAULT_COST.input,
        output: definition.cost?.output ?? DEFAULT_COST.output,
        cacheRead: definition.cost?.cacheRead ?? DEFAULT_COST.cacheRead,
        cacheWrite: definition.cost?.cacheWrite ?? DEFAULT_COST.cacheWrite,
      },
      contextWindow: definition.contextWindow ?? 128_000,
      maxTokens: definition.maxTokens ?? 16_384,
      ...(headers === undefined ? {} : { headers }),
      ...(definition.samplingParams === undefined
        ? {}
        : { samplingParams: definition.samplingParams }),
    };
  });

const streamsFor = (
  models: readonly Model<Api>[],
): Effect.Effect<Partial<Record<Api, ProviderStreams>>, ModelsJsonError> =>
  Effect.gen(function* () {
    const streams: Partial<Record<Api, ProviderStreams>> = {};
    for (const model of models) {
      if (streams[model.api] !== undefined) continue;
      const implementation = getApiProvider(model.api);
      if (implementation === undefined) {
        return yield* Effect.fail(
          new ModelsJsonError({
            message: `Provider ${model.provider}, model ${model.id}: no stream implementation for api "${model.api}".`,
          }),
        );
      }
      streams[model.api] = {
        stream: implementation.stream as ProviderStreams["stream"],
        streamSimple: implementation.streamSimple as ProviderStreams["streamSimple"],
      };
    }
    return streams;
  });

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
    name: "API key",
    login: async (interaction: AuthInteraction) => ({
      type: "api_key" as const,
      key: await interaction.prompt({ type: "secret", message: `Enter API key for ${providerId}` }),
    }),
    check: async (input) => {
      if (input.credential?.key) return { type: "api_key" as const, source: "stored credential" };
      if (rawKey !== undefined) {
        // Commands are not executed during checks (listing must stay
        // side-effect free); a configured command counts as configured.
        if (isCommandConfigValue(rawKey))
          return { type: "api_key" as const, source: "configured API key" };
        if (getMissingConfigValueEnvVarNames(rawKey, env).length === 0) {
          return { type: "api_key" as const, source: "configured API key" };
        }
      }
      return undefined;
    },
    resolve: async (input) => {
      if (input.credential?.key) {
        return {
          auth: { apiKey: input.credential.key },
          ...(input.credential.env === undefined ? {} : { env: input.credential.env }),
          source: "stored credential",
        };
      }
      if (rawKey !== undefined) {
        const key = resolveConfigValue(rawKey, env);
        if (key !== undefined) return { auth: { apiKey: key }, source: "configured API key" };
      }
      return undefined;
    },
  };
};

// ---------------------------------------------------------------------------
// The catalog service
// ---------------------------------------------------------------------------

export interface CatalogOptions {
  authPath?: string;
  modelsPath?: string;
}

/** The threads' shared model runtime: builtins + models.json, auth-aware. */
export class ModelCatalog extends Context.Service<ModelCatalog, ModelCatalogShape>()(
  "ModelCatalog",
) {}

/** Build the catalog from auth.json, models.json, and pi's builtin providers. */
export const ModelCatalogLive = (
  options: CatalogOptions = {},
): Layer.Layer<ModelCatalog, never, FileSystem.FileSystem> =>
  Layer.effect(
    ModelCatalog,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      // The daemon's own environment resolves models.json `$VAR`/`!cmd` values.
      const env = process.env as Record<string, string>;
      registerBuiltInApiProviders();
      const credentials = yield* AuthJsonCredentialStore.load(
        options.authPath ?? getAuthJsonPath(),
        fs,
      );
      // The shared construction: opencode-go + the scripted fixture over
      // the auth source (model-catalog-factory.ts, the one SAKU_FAKE_MODEL
      // check). models.json providers are added below.
      const catalog = createModelCatalog({ auth: { credentials }, env });

      const config = yield* loadModelsJsonFrom(fs, options.modelsPath ?? getModelsJsonPath());
      for (const [providerId, providerConfig] of Object.entries(config.providers)) {
        const base = catalog.models.getProvider(providerId);
        yield* (
          base === undefined
            ? buildCustomProvider(providerId, providerConfig, env).pipe(
                Effect.map((provider) => catalog.models.setProvider(provider)),
              )
            : overlayBuiltinProvider(providerId, base, providerConfig, env).pipe(
                Effect.map((replacement) => {
                  if (replacement !== undefined) catalog.models.setProvider(replacement);
                }),
              )
        ).pipe(
          Effect.catch((error) =>
            Effect.logWarning(`models.json: skipping provider "${providerId}": ${String(error)}`),
          ),
        );
      }

      return ModelCatalog.of(catalog);
    }),
  );

const loadModelsJsonFrom = (
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<ModelsJson, never, never> =>
  Effect.gen(function* () {
    const raw = yield* fs.readFileString(path).pipe(
      Effect.catch((error) => {
        // No models.json is the default install; anything else is worth knowing.
        if (isNotFound(error)) return Effect.succeed(undefined);
        return Effect.logWarning(`failed to read models.json: ${String(error)}`).pipe(
          Effect.as(undefined),
        );
      }),
    );
    if (raw === undefined) return { providers: {} };
    const parsed = Result.try(() => DECODE_MODELS_JSON(raw));
    if (Result.isFailure(parsed)) {
      yield* Effect.logWarning(`models.json is not valid JSON: ${String(parsed.failure)}`);
      return { providers: {} };
    }
    return parsed.success;
  });

/** A models.json provider that is not a builtin: full construction. */
const buildCustomProvider = (
  providerId: string,
  config: ModelsJsonProviderConfig,
  env: Record<string, string>,
): Effect.Effect<Provider, ModelsJsonError> =>
  Effect.gen(function* () {
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
    return createProvider({
      id: providerId,
      name: config.name ?? providerId,
      ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
      ...(headers === undefined ? {} : { headers }),
      auth,
      models,
      api: streams,
    });
  });

/**
 * models.json overlay over a builtin provider: base url, headers, model list
 * replacement, and per-model overrides. The provider's own auth is reused.
 */
const overlayBuiltinProvider = (
  providerId: string,
  base: Provider,
  config: ModelsJsonProviderConfig,
  env: Record<string, string>,
): Effect.Effect<Provider | undefined, ModelsJsonError> =>
  Effect.gen(function* () {
    const resolvedHeaders = resolveHeaders(config.headers, env);
    const baseModels = base.getModels();
    let models = baseModels.map((model) => ({
      ...model,
      baseUrl: config.baseUrl ?? model.baseUrl,
      ...(resolvedHeaders === undefined ? {} : { headers: resolvedHeaders }),
    }));
    for (const definition of config.models ?? []) {
      const existingIndex = models.findIndex((model) => model.id === definition.id);
      const built = yield* modelFromJson(providerId, definition, config, env);
      if (existingIndex >= 0) {
        models[existingIndex] = built;
      } else {
        models.push(built);
      }
    }
    for (const [modelId, override] of Object.entries(config.modelOverrides ?? {})) {
      const index = models.findIndex((model) => model.id === modelId);
      const current = models[index];
      if (index < 0 || current === undefined) continue;
      models[index] = {
        ...current,
        name: override.name ?? current.name,
        reasoning: override.reasoning ?? current.reasoning,
        contextWindow: override.contextWindow ?? current.contextWindow,
        maxTokens: override.maxTokens ?? current.maxTokens,
        baseUrl: override.baseUrl ?? current.baseUrl,
        ...(override.headers === undefined ? {} : { headers: override.headers }),
        input: [...(override.input ?? current.input)],
        cost: {
          ...current.cost,
          input: override.cost?.input ?? current.cost.input,
          output: override.cost?.output ?? current.cost.output,
          cacheRead: override.cost?.cacheRead ?? current.cost.cacheRead,
          cacheWrite: override.cost?.cacheWrite ?? current.cost.cacheWrite,
        },
      };
    }
    const changed =
      config.baseUrl !== undefined ||
      resolvedHeaders !== undefined ||
      (config.models?.length ?? 0) > 0 ||
      Object.keys(config.modelOverrides ?? {}).length > 0;
    if (!changed) return undefined;
    const streams = yield* streamsFor(models);
    return createProvider({
      id: providerId,
      name: config.name ?? base.name,
      ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
      ...(resolvedHeaders === undefined ? {} : { headers: resolvedHeaders }),
      auth: base.auth,
      models,
      api: streams,
    });
  });
