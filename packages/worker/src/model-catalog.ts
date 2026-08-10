/**
 * Model catalog (model-catalog.ts): the threads' shared view of pi's models,
 * provided as a service (`ModelCatalogLive` — the daemon's only provider).
 *
 * v1 reads what the user already has:
 * - `auth.json` — provider credentials (read-only CredentialStore; writes
 *   would be daemon-owned, out of v1 scope)
 * - `models.json` — custom providers (api keys, base urls, model lists) and
 *   overlays over builtin providers
 * - pi's builtin provider catalog (`@earendil-works/pi-ai/providers/all`)
 *
 * No extension providers, no network model refresh. The env override
 * `PI_CODING_AGENT_DIR` redirects auth.json/models.json.
 */

import { dirname } from "node:path";
import { Context, Effect, FileSystem, Layer, Result, Schema } from "effect";
import {
  createModels,
  createProvider,
  type Api,
  type ApiKeyAuth,
  type AuthInteraction,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  type Model,
  type MutableModels,
  type Provider,
  type ProviderAuth,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { getApiProvider, registerBuiltInApiProviders } from "@earendil-works/pi-ai/compat";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { WireModelInfo } from "@saku/wire";

import { isNotFound } from "./fs.ts";
import { getAuthJsonPath, getModelsJsonPath } from "./paths.ts";
import {
  getMissingConfigValueEnvVarNames,
  isCommandConfigValue,
  resolveConfigValue,
  resolveHeaders,
} from "./config-value.ts";

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

  static async load(path: string, fs: FileSystem.FileSystem): Promise<AuthJsonCredentialStore> {
    const content = await Effect.runPromise(fs.readFileString(path).pipe(Effect.result));
    if (Result.isFailure(content)) {
      // A missing auth.json is the default install; anything else is worth
      // knowing (the daemon never mutates credentials in v1, so a malformed
      // file is the user's to fix).
      if (!isNotFound(content.failure)) {
        console.error(`[worker] failed to read auth.json: ${String(content.failure)}`);
      }
      return new AuthJsonCredentialStore(path, fs, {});
    }
    const parsed = Result.try(() => JSON.parse(content.success) as unknown);
    if (Result.isFailure(parsed)) {
      console.error(`[worker] failed to read auth.json: ${String(parsed.failure)}`);
      return new AuthJsonCredentialStore(path, fs, {});
    }
    if (typeof parsed.success === "object" && parsed.success !== null) {
      return new AuthJsonCredentialStore(path, fs, parsed.success as Record<string, Credential>);
    }
    return new AuthJsonCredentialStore(path, fs, {});
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return this.data[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(this.data).map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const next = await fn(this.data[providerId]);
    if (next === undefined) return this.data[providerId];
    this.data[providerId] = next;
    this.persist();
    return next;
  }

  async delete(providerId: string): Promise<void> {
    delete this.data[providerId];
    this.persist();
  }

  private async persist(): Promise<void> {
    await Effect.runPromise(
      this.fs
        .makeDirectory(dirname(this.path), { recursive: true })
        .pipe(Effect.andThen(this.fs.writeFileString(this.path, `${JSON.stringify(this.data, null, 2)}\n`, { mode: AUTH_JSON_FILE_MODE })))
        .pipe(Effect.andThen(this.fs.chmod(this.path, AUTH_JSON_FILE_MODE))),
    );
  }
}

// ---------------------------------------------------------------------------
// models.json → providers
// ---------------------------------------------------------------------------

interface ModelsJsonModel {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  input?: ("text" | "image")[];
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  headers?: Record<string, string>;
  samplingParams?: Record<string, unknown>;
}

interface ModelsJsonProviderConfig {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  headers?: Record<string, string>;
  models?: ModelsJsonModel[];
  modelOverrides?: Record<string, Partial<Omit<ModelsJsonModel, "id">>>;
}

type ModelsJson = { providers: Record<string, ModelsJsonProviderConfig> };

const DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const modelFromJson = (
  providerId: string,
  definition: ModelsJsonModel,
  config: ModelsJsonProviderConfig,
  env: Record<string, string>,
): Model<Api> => {
  const api = (definition.api ?? config.api) as Api | undefined;
  if (api === undefined) {
    throw new Error(
      `Provider ${providerId}, model ${definition.id}: no "api" specified. Set at provider or model level.`,
    );
  }
  const baseUrl = definition.baseUrl ?? config.baseUrl;
  if (baseUrl === undefined) {
    throw new Error(`Provider ${providerId}: "baseUrl" is required when defining custom models.`);
  }
  const headers = resolveHeaders(definition.headers, env);
  return {
    id: definition.id,
    name: definition.name ?? definition.id,
    api,
    provider: providerId,
    baseUrl,
    reasoning: definition.reasoning ?? false,
    input: definition.input ?? ["text"],
    cost: { ...DEFAULT_COST, ...definition.cost },
    contextWindow: definition.contextWindow ?? 128_000,
    maxTokens: definition.maxTokens ?? 16_384,
    ...(headers === undefined ? {} : { headers }),
    ...(definition.samplingParams === undefined ? {} : { samplingParams: definition.samplingParams }),
  };
};

const streamsFor = (models: readonly Model<Api>[]): Partial<Record<Api, ProviderStreams>> => {
  const streams: Partial<Record<Api, ProviderStreams>> = {};
  for (const model of models) {
    if (streams[model.api] !== undefined) continue;
    const implementation = getApiProvider(model.api);
    if (implementation === undefined) {
      throw new Error(`Provider ${model.provider}, model ${model.id}: no stream implementation for api "${model.api}".`);
    }
    streams[model.api] = {
      stream: implementation.stream as ProviderStreams["stream"],
      streamSimple: implementation.streamSimple as ProviderStreams["streamSimple"],
    };
  }
  return streams;
};

/**
 * ApiKeyAuth for models.json custom providers: a stored credential wins,
 * otherwise the configured value resolves against the daemon's environment
 * (`$VAR` interpolation, `!command` execution — see config-value.ts).
 */
const apiKeyAuthFor = (providerId: string, config: ModelsJsonProviderConfig, env: Record<string, string>): ApiKeyAuth => {
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
        if (isCommandConfigValue(rawKey)) return { type: "api_key" as const, source: "configured API key" };
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

export interface ModelCatalogShape {
  /** The shared `MutableModels` collection (also feeds core's compaction helpers). */
  readonly models: MutableModels;
  /** Models whose providers have complete auth configuration. */
  readonly available: () => Effect.Effect<readonly Model<Api>[], never>;
  readonly hasAuth: (providerId: string) => Effect.Effect<boolean, never>;
  readonly getModel: (providerId: string, modelId: string) => Model<Api> | undefined;
  readonly toWireInfo: (model: Model<Api>) => WireModelInfo;
}

/** The threads' shared model runtime: builtins + models.json, auth-aware. */
export class ModelCatalog extends Context.Service<ModelCatalog, ModelCatalogShape>()("ModelCatalog") {}

/** Build the catalog from auth.json, models.json, and pi's builtin providers. */
export const ModelCatalogLive = (options: CatalogOptions = {}): Layer.Layer<ModelCatalog, never, FileSystem.FileSystem> =>
  Layer.effect(
    ModelCatalog,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      // The daemon's own environment resolves models.json `$VAR`/`!cmd` values.
      const env = process.env as Record<string, string>;
      registerBuiltInApiProviders();
      const credentials = yield* Effect.promise(() =>
        AuthJsonCredentialStore.load(options.authPath ?? getAuthJsonPath(), fs),
      );
      const models = createModels({ credentials });

      for (const provider of builtinProviders()) {
        models.setProvider(provider);
      }

      const config = yield* loadModelsJsonFrom(fs, options.modelsPath ?? getModelsJsonPath());
      for (const [providerId, providerConfig] of Object.entries(config.providers)) {
        const base = models.getProvider(providerId);
        try {
          if (base === undefined) {
            models.setProvider(buildCustomProvider(providerId, providerConfig, env));
          } else {
            const replacement = overlayBuiltinProvider(providerId, base, providerConfig, env);
            if (replacement !== undefined) models.setProvider(replacement);
          }
        } catch (error) {
          yield* Effect.logWarning(`models.json: skipping provider "${providerId}": ${String(error)}`);
        }
      }

      return ModelCatalog.of({
        models,
        available: () => Effect.tryPromise(() => models.getAvailable()),
        hasAuth: (providerId) =>
          Effect.tryPromise(() => models.checkAuth(providerId))
            .pipe(Effect.map((check) => check !== undefined))
            .pipe(Effect.catchEager(() => Effect.succeed(false))),
        getModel: (providerId, modelId) => models.getModel(providerId, modelId),
        toWireInfo: (model) => ({
          provider: model.provider,
          id: model.id,
          contextWindow: model.contextWindow,
          reasoning: model.reasoning,
        }),
      });
    }),
  );

const loadModelsJsonFrom = (fs: FileSystem.FileSystem, path: string): Effect.Effect<ModelsJson, never, never> =>
  Effect.gen(function* () {
    const raw = yield* fs.readFileString(path).pipe(
      Effect.catch((error) => {
        // No models.json is the default install; anything else is worth knowing.
        if (isNotFound(error)) return Effect.succeed("");
        return Effect.logWarning(`failed to read models.json: ${String(error)}`).pipe(Effect.as(""));
      }),
    );
    const parsed = Result.try(() => JSON.parse(raw) as unknown);
    if (Result.isFailure(parsed)) {
      yield* Effect.logWarning(`models.json is not valid JSON: ${String(parsed.failure)}`);
    }
    if (Result.isSuccess(parsed) && typeof parsed.success === "object" && parsed.success !== null) {
      const providers = (parsed.success as { providers?: unknown }).providers;
      if (typeof providers === "object" && providers !== null) {
        return { providers: providers as ModelsJson["providers"] };
      }
    }
    return { providers: {} };
  });

/** A models.json provider that is not a builtin: full construction. */
const buildCustomProvider = (
  providerId: string,
  config: ModelsJsonProviderConfig,
  env: Record<string, string>,
): Provider => {
  const models = (config.models ?? []).map((definition) => modelFromJson(providerId, definition, config, env));
  if (models.length === 0) {
    throw new Error("no models defined");
  }
  const auth: ProviderAuth = { apiKey: apiKeyAuthFor(providerId, config, env) };
  const headers = resolveHeaders(config.headers, env);
  return createProvider({
    id: providerId,
    name: config.name ?? providerId,
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    ...(headers === undefined ? {} : { headers }),
    auth,
    models,
    api: streamsFor(models),
  });
};

/**
 * models.json overlay over a builtin provider: base url, headers, model list
 * replacement, and per-model overrides. The provider's own auth is reused.
 */
const overlayBuiltinProvider = (
  providerId: string,
  base: Provider,
  config: ModelsJsonProviderConfig,
  env: Record<string, string>,
): Provider | undefined => {
  const resolvedHeaders = resolveHeaders(config.headers, env);
  const baseModels = base.getModels();
  let models = baseModels.map((model) => ({
    ...model,
    baseUrl: config.baseUrl ?? model.baseUrl,
    ...(resolvedHeaders === undefined ? {} : { headers: resolvedHeaders }),
  }));
  for (const definition of config.models ?? []) {
    const existingIndex = models.findIndex((model) => model.id === definition.id);
    const built = modelFromJson(providerId, definition, config, env);
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
      input: override.input ?? current.input,
      cost: { ...current.cost, ...override.cost },
    };
  }
  const changed =
    config.baseUrl !== undefined ||
    resolvedHeaders !== undefined ||
    (config.models?.length ?? 0) > 0 ||
    Object.keys(config.modelOverrides ?? {}).length > 0;
  if (!changed) return undefined;
  return createProvider({
    id: providerId,
    name: config.name ?? base.name,
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    ...(resolvedHeaders === undefined ? {} : { headers: resolvedHeaders }),
    auth: base.auth,
    models,
    api: streamsFor(models),
  });
};
