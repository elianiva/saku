/**
 * Model catalog (model-catalog.ts): the threads' shared view of pi's models.
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

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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

import { getAuthJsonPath, getModelsJsonPath } from "./paths.ts";

// ---------------------------------------------------------------------------
// auth.json → CredentialStore
// ---------------------------------------------------------------------------

const AUTH_JSON_FILE_MODE = 0o600;

/** Credential store over pi's auth.json (`Record<providerId, Credential>`). */
class AuthJsonCredentialStore implements CredentialStore {
  private readonly path: string;
  private data: Record<string, Credential>;

  constructor(path: string, initial: Record<string, Credential>) {
    this.path = path;
    this.data = initial;
  }

  static load(path: string): AuthJsonCredentialStore {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (typeof parsed === "object" && parsed !== null) {
        return new AuthJsonCredentialStore(path, parsed as Record<string, Credential>);
      }
    } catch {
      // Missing or malformed auth.json: start empty. The daemon never
      // mutates credentials in v1, so a malformed file is the user's to fix.
    }
    return new AuthJsonCredentialStore(path, {});
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

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(this.data, null, 2)}\n`, { mode: AUTH_JSON_FILE_MODE });
    chmodSync(this.path, AUTH_JSON_FILE_MODE);
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

const modelFromJson = (providerId: string, definition: ModelsJsonModel, config: ModelsJsonProviderConfig): Model<Api> => {
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
    ...(definition.headers === undefined ? {} : { headers: definition.headers }),
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

/** ApiKeyAuth for models.json custom providers: configured key or env var. */
const apiKeyAuthFor = (providerId: string, config: ModelsJsonProviderConfig): ApiKeyAuth => {
  const rawKey = config.apiKey;
  return {
    name: "API key",
    login: async (interaction: AuthInteraction) => ({
      type: "api_key" as const,
      key: await interaction.prompt({ type: "secret", message: `Enter API key for ${providerId}` }),
    }),
    check: async (input) => {
      if (input.credential?.key) return { type: "api_key" as const, source: "stored credential" };
      if (rawKey !== undefined && !isCommandConfigValue(rawKey)) {
        for (const name of envNamesOf(rawKey)) {
          if ((await input.ctx.env(name)) === undefined) return undefined;
        }
        return { type: "api_key" as const, source: "configured API key" };
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
      if (rawKey !== undefined && !isCommandConfigValue(rawKey)) {
        const env = await resolveEnv(rawKey, input.ctx);
        return {
          auth: { apiKey: rawKey },
          ...(env === undefined ? {} : { env }),
          source: "configured API key",
        };
      }
      return undefined;
    },
  };
};

const isCommandConfigValue = (value: string): boolean => value.startsWith("$") && !value.includes(" ");
const envNamesOf = (value: string): string[] =>
  value.split(/\s+/u).filter((part) => part.startsWith("$")).map((part) => part.slice(1));
const resolveEnv = async (value: string, ctx: { env(name: string): Promise<string | undefined> }): Promise<Record<string, string> | undefined> => {
  const env: Record<string, string> = {};
  for (const name of envNamesOf(value)) {
    const resolved = await ctx.env(name);
    if (resolved !== undefined) env[name] = resolved;
  }
  return Object.keys(env).length > 0 ? env : undefined;
};

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

export interface CatalogOptions {
  authPath?: string;
  modelsPath?: string;
}

/** Shared model runtime for all threads: builtins + models.json, auth-aware. */
export class ModelCatalog {
  readonly models: MutableModels;

  private constructor(models: MutableModels) {
    this.models = models;
  }

  static create(options: CatalogOptions = {}): ModelCatalog {
    registerBuiltInApiProviders();
    const credentials = AuthJsonCredentialStore.load(options.authPath ?? getAuthJsonPath());
    const models = createModels({ credentials });

    for (const provider of builtinProviders()) {
      models.setProvider(provider);
    }

    const config = loadModelsJsonFrom(options.modelsPath ?? getModelsJsonPath());
    for (const [providerId, providerConfig] of Object.entries(config.providers)) {
      const base = models.getProvider(providerId);
      try {
        if (base === undefined) {
          models.setProvider(buildCustomProvider(providerId, providerConfig));
        } else {
          const replacement = overlayBuiltinProvider(providerId, base, providerConfig);
          if (replacement !== undefined) models.setProvider(replacement);
        }
      } catch (error) {
        console.error(`[worker] models.json: skipping provider "${providerId}": ${String(error)}`);
      }
    }
    return new ModelCatalog(models);
  }

  /** All known models (sync). */
  allModels(): readonly Model<Api>[] {
    const out: Model<Api>[] = [];
    for (const provider of this.models.getProviders()) {
      out.push(...provider.getModels());
    }
    return out;
  }

  /** Models whose providers have complete auth configuration. */
  async available(): Promise<readonly Model<Api>[]> {
    return this.models.getAvailable();
  }

  async hasAuth(providerId: string): Promise<boolean> {
    return (await this.models.checkAuth(providerId)) !== undefined;
  }

  getModel(providerId: string, modelId: string): Model<Api> | undefined {
    return this.models.getModel(providerId, modelId);
  }

  toWireInfo(model: Model<Api>): WireModelInfo {
    return {
      provider: model.provider,
      id: model.id,
      contextWindow: model.contextWindow,
      reasoning: model.reasoning,
    };
  }

  /** The `Models` collection — also feeds core's compaction helpers. */
  get piModels(): MutableModels {
    return this.models;
  }
}

const loadModelsJsonFrom = (path: string): ModelsJson => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed === "object" && parsed !== null) {
      const providers = (parsed as ModelsJson).providers;
      if (typeof providers === "object" && providers !== null) {
        return { providers: providers as ModelsJson["providers"] };
      }
    }
  } catch {
    // No models.json (or unparsable): builtins only.
  }
  return { providers: {} };
};

/** A models.json provider that is not a builtin: full construction. */
const buildCustomProvider = (providerId: string, config: ModelsJsonProviderConfig): Provider => {
  const models = (config.models ?? []).map((definition) => modelFromJson(providerId, definition, config));
  if (models.length === 0) {
    throw new Error("no models defined");
  }
  const auth: ProviderAuth = { apiKey: apiKeyAuthFor(providerId, config) };
  return createProvider({
    id: providerId,
    name: config.name ?? providerId,
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    ...(config.headers === undefined ? {} : { headers: config.headers }),
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
): Provider | undefined => {
  const baseModels = base.getModels();
  let models = baseModels.map((model) => ({
    ...model,
    baseUrl: config.baseUrl ?? model.baseUrl,
    ...(config.headers === undefined ? {} : { headers: config.headers }),
  }));
  for (const definition of config.models ?? []) {
    const existingIndex = models.findIndex((model) => model.id === definition.id);
    const built = modelFromJson(providerId, definition, config);
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
    config.headers !== undefined ||
    (config.models?.length ?? 0) > 0 ||
    Object.keys(config.modelOverrides ?? {}).length > 0;
  if (!changed) return undefined;
  return createProvider({
    id: providerId,
    name: config.name ?? base.name,
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    ...(config.headers === undefined ? {} : { headers: config.headers }),
    auth: base.auth,
    models,
    api: streamsFor(models),
  });
};
