import type { ASRProvider } from "./asr.ts";
import { quoteId } from "./quoteId.ts";

/**
 * Environment-shaped record used to resolve provider credentials.
 * `process.env` satisfies this, but tests can pass a plain object.
 */
export type ProviderEnv = Readonly<Record<string, string | undefined>>;

/**
 * Outcome of reading one provider's config out of the environment.
 *
 * Config shape is deliberately provider-specific: `{ apiKey }` is NOT universal.
 * Azure additionally needs a region, Google Cloud STT needs full IAM credentials
 * rather than a key, and Gladia needs a pre-flight step to mint a session URL.
 * Each provider therefore owns both the shape of its config and how to read it.
 */
export type ConfigResolution<TConfig> =
  | { ok: true; config: TConfig }
  | { ok: false; missing: readonly string[] };

/**
 * What a provider must declare to join the registry. `TConfig` never escapes:
 * `defineProvider` pairs `resolveConfig` with `create` and erases the type,
 * so the registry can hold providers with wildly different config shapes.
 *
 * A provider is the *vendor* layer: how to build a raw `ASRProvider` for one
 * model. What users select is a **model configuration**, which pairs a provider
 * and model with a post-processing chain — see `./configuration.ts`.
 */
export interface ProviderSpec<TConfig> {
  /** Stable id, referenced by a configuration and by `ASR_PROVIDER`. */
  readonly id: string;
  /** Human-readable name, for listings and error messages. */
  readonly label: string;
  /** Allowlist of model ids this provider serves. The first is the default. */
  readonly models: readonly [string, ...string[]];
  /** Read this provider's credentials/config out of the environment. */
  resolveConfig(env: ProviderEnv): ConfigResolution<TConfig>;
  /** Build a provider. `model` is always one of `models`. */
  create(config: TConfig, model: string): ASRProvider;
}

export type ProviderErrorCode = "unknown_provider" | "unknown_model" | "not_configured";

export interface ProviderError {
  readonly code: ProviderErrorCode;
  readonly message: string;
  /** Env var names that must be set. Present only for `not_configured`. */
  readonly missing?: readonly string[];
}

export type ProviderResolution =
  | { ok: true; provider: ASRProvider; providerId: string; model: string }
  | { ok: false; error: ProviderError };

/** A provider spec after type erasure, as held by the registry. */
export interface ProviderDefinition {
  readonly id: string;
  readonly label: string;
  readonly models: readonly string[];
  readonly defaultModel: string;
  /** True when the environment carries everything this provider needs. */
  isConfigured(env: ProviderEnv): boolean;
  /** Env var names this provider needs but the environment does not carry. */
  missingConfig(env: ProviderEnv): readonly string[];
  /** Validate the model, read config, and instantiate. Never throws. */
  resolve(env: ProviderEnv, model?: string): ProviderResolution;
}

export function defineProvider<TConfig>(spec: ProviderSpec<TConfig>): ProviderDefinition {
  const defaultModel = spec.models[0];
  return {
    id: spec.id,
    label: spec.label,
    models: spec.models,
    defaultModel,

    isConfigured(env) {
      return spec.resolveConfig(env).ok;
    },

    missingConfig(env) {
      const resolution = spec.resolveConfig(env);
      return resolution.ok ? [] : resolution.missing;
    },

    resolve(env, model) {
      const selected = model ?? defaultModel;
      if (!spec.models.includes(selected)) {
        return {
          ok: false,
          error: {
            code: "unknown_model",
            message: `Unknown model ${quoteId(selected)} for ASR provider ${quoteId(spec.id)}`,
          },
        };
      }
      const config = spec.resolveConfig(env);
      if (!config.ok) {
        return {
          ok: false,
          error: {
            code: "not_configured",
            message: `ASR provider "${spec.id}" is not configured`,
            missing: config.missing,
          },
        };
      }
      return {
        ok: true,
        provider: spec.create(config.config, selected),
        providerId: spec.id,
        model: selected,
      };
    },
  };
}

export interface ASRProviderRegistry {
  /** Ids of every registered provider, in registration order. */
  readonly ids: readonly string[];
  list(): readonly ProviderDefinition[];
  get(id: string): ProviderDefinition | undefined;
  /** Resolve `providerId` + optional `model` into a provider. Never throws. */
  resolve(env: ProviderEnv, request: { provider: string; model?: string }): ProviderResolution;
}

export function createProviderRegistry(
  definitions: readonly ProviderDefinition[],
): ASRProviderRegistry {
  const byId = new Map<string, ProviderDefinition>();
  for (const definition of definitions) {
    if (byId.has(definition.id)) {
      throw new Error(`Duplicate ASR provider id: ${definition.id}`);
    }
    byId.set(definition.id, definition);
  }

  return {
    get ids() {
      return [...byId.keys()];
    },
    list() {
      return [...byId.values()];
    },
    get(id) {
      return byId.get(id);
    },
    resolve(env, request) {
      const definition = byId.get(request.provider);
      if (!definition) {
        return {
          ok: false,
          error: {
            code: "unknown_provider",
            message: `Unknown ASR provider ${quoteId(request.provider)}`,
          },
        };
      }
      return definition.resolve(env, request.model);
    },
  };
}
