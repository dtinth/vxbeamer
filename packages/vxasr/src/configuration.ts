import type { ASRProvider } from "./asr.ts";
import type { ASRProviderRegistry, ConfigResolution, ProviderEnv } from "./registry.ts";

/**
 * A post-processing step layered over a raw provider — `withGroqEnhancement`
 * is the only one today. Like a provider, a decorator reads its own credentials
 * out of the environment and reports what is missing rather than throwing, so
 * `{ apiKey }` is not assumed here either.
 */
export interface DecoratorSpec<TConfig> {
  readonly id: string;
  resolveConfig(env: ProviderEnv): ConfigResolution<TConfig>;
  wrap(provider: ASRProvider, config: TConfig): ASRProvider;
}

/** A decorator spec after type erasure. */
export interface DecoratorDefinition {
  readonly id: string;
  /** Env var names this decorator needs but the environment does not carry. */
  missingConfig(env: ProviderEnv): readonly string[];
  apply(
    provider: ASRProvider,
    env: ProviderEnv,
  ): { ok: true; provider: ASRProvider } | { ok: false; missing: readonly string[] };
}

export function defineDecorator<TConfig>(spec: DecoratorSpec<TConfig>): DecoratorDefinition {
  return {
    id: spec.id,
    missingConfig(env) {
      const resolution = spec.resolveConfig(env);
      return resolution.ok ? [] : resolution.missing;
    },
    apply(provider, env) {
      const resolution = spec.resolveConfig(env);
      if (!resolution.ok) return { ok: false, missing: resolution.missing };
      return { ok: true, provider: spec.wrap(provider, resolution.config) };
    },
  };
}

/**
 * A **model configuration**: a provider, a model, and the post-processing chain
 * applied to it. This — not the provider, and not the provider+model pair — is
 * the unit users select and evaluate.
 *
 * Enhancement is part of a configuration's *identity*, not a flag on the
 * request: `qwen3-asr-flash-realtime` raw and `qwen3-asr-flash-realtime+groq`
 * are two separate configurations that compete on equal terms. Because the
 * catalogue is declared rather than generated, a combination that should not
 * exist simply is not declared — which is how the mock provider is kept out of
 * any chain that would make a real LLM call.
 */
export interface ConfigurationSpec {
  /** Provider id, which must be registered in the provider registry. */
  readonly provider: string;
  /** Defaults to the provider's default model. */
  readonly model?: string;
  /** Decorator ids, applied in order. */
  readonly postProcessing?: readonly string[];
  /** Display name. Defaults to the derived id. */
  readonly label?: string;
}

/**
 * Derives a configuration's id from what it is made of, so an id can never
 * drift from its content and two identical compositions collide by
 * construction. Votes and eval results reference these ids, so they must stay
 * stable: `qwen/qwen3-asr-flash-realtime+groq`.
 *
 * Note the `+`: a client must URL-encode the id (`URLSearchParams` does this),
 * since a bare `+` in a query string decodes to a space.
 */
export function buildConfigurationId(
  provider: string,
  model: string,
  postProcessing: readonly string[] = [],
): string {
  return `${provider}/${model}${postProcessing.map((id) => `+${id}`).join("")}`;
}

export type ConfigurationErrorCode = "unknown_configuration" | "not_configured";

export interface ConfigurationError {
  readonly code: ConfigurationErrorCode;
  readonly message: string;
  /** Env var names that must be set. Present only for `not_configured`. */
  readonly missing?: readonly string[];
}

export type ConfigurationResolution =
  | { ok: true; provider: ASRProvider; configurationId: string }
  | { ok: false; error: ConfigurationError };

export interface ConfigurationDefinition {
  readonly id: string;
  readonly label: string;
  readonly providerId: string;
  readonly model: string;
  readonly postProcessing: readonly string[];
  /** True when the environment carries credentials for the provider and every decorator. */
  isConfigured(env: ProviderEnv): boolean;
  /** Every env var this configuration needs but the environment does not carry. */
  missingConfig(env: ProviderEnv): readonly string[];
  /** Build the fully decorated provider. Never throws. */
  resolve(env: ProviderEnv): ConfigurationResolution;
}

export interface ASRConfigurationCatalogue {
  readonly ids: readonly string[];
  /** The vendor layer these configurations are composed from. */
  readonly providers: ASRProviderRegistry;
  list(): readonly ConfigurationDefinition[];
  get(id: string): ConfigurationDefinition | undefined;
  /** Resolve a configuration id into a decorated provider. Never throws. */
  resolve(env: ProviderEnv, id: string): ConfigurationResolution;
}

/**
 * Ids reach us from untrusted query params, and the errors quoting them end up
 * in places with hard length limits (a websocket close reason caps at 123
 * bytes). Keep the echo short so an absurd id cannot burst the frame.
 */
function quoteId(id: string): string {
  return JSON.stringify(id.length > 32 ? `${id.slice(0, 32)}…` : id);
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Builds the catalogue, validating every configuration against the provider
 * registry and decorator list up front. The catalogue is code, so an unknown
 * provider, model, or decorator is a programming error and throws here rather
 * than surfacing as a per-request failure.
 */
export function createConfigurationCatalogue(options: {
  providers: ASRProviderRegistry;
  decorators?: readonly DecoratorDefinition[];
  configurations: readonly ConfigurationSpec[];
}): ASRConfigurationCatalogue {
  const { providers } = options;
  const decoratorsById = new Map((options.decorators ?? []).map((d) => [d.id, d]));
  const byId = new Map<string, ConfigurationDefinition>();

  for (const spec of options.configurations) {
    const providerDefinition = providers.get(spec.provider);
    if (!providerDefinition) {
      throw new Error(`Configuration references unknown ASR provider: ${spec.provider}`);
    }

    const model = spec.model ?? providerDefinition.defaultModel;
    if (!providerDefinition.models.includes(model)) {
      throw new Error(`ASR provider "${spec.provider}" does not serve model "${model}"`);
    }

    const postProcessing = spec.postProcessing ?? [];
    const chain = postProcessing.map((id) => {
      const decorator = decoratorsById.get(id);
      if (!decorator) throw new Error(`Configuration references unknown decorator: ${id}`);
      return decorator;
    });

    const id = buildConfigurationId(spec.provider, model, postProcessing);
    if (byId.has(id)) throw new Error(`Duplicate ASR configuration id: ${id}`);

    const missingConfig = (env: ProviderEnv) =>
      dedupe([
        ...providerDefinition.missingConfig(env),
        ...chain.flatMap((decorator) => decorator.missingConfig(env)),
      ]);

    byId.set(id, {
      id,
      label: spec.label ?? id,
      providerId: spec.provider,
      model,
      postProcessing,
      missingConfig,
      isConfigured: (env) => missingConfig(env).length === 0,
      resolve(env) {
        // Report everything that is missing at once, across the provider and
        // the whole chain, rather than one credential per attempt.
        const missing = missingConfig(env);
        if (missing.length > 0) {
          return {
            ok: false,
            error: {
              code: "not_configured",
              message: `ASR configuration ${quoteId(id)} is not configured`,
              missing,
            },
          };
        }

        const resolution = providers.resolve(env, { provider: spec.provider, model });
        if (!resolution.ok) {
          // Not reachable today — the model is validated at construction and the
          // credentials were just checked — but report it rather than throw.
          return {
            ok: false,
            error: {
              code: "not_configured",
              message: resolution.error.message,
              missing: resolution.error.missing,
            },
          };
        }

        let provider = resolution.provider;
        for (const decorator of chain) {
          const applied = decorator.apply(provider, env);
          if (!applied.ok) {
            return {
              ok: false,
              error: {
                code: "not_configured",
                message: `ASR configuration ${quoteId(id)} is not configured`,
                missing: applied.missing,
              },
            };
          }
          provider = applied.provider;
        }
        return { ok: true, provider, configurationId: id };
      },
    });
  }

  return {
    get ids() {
      return [...byId.keys()];
    },
    providers,
    list() {
      return [...byId.values()];
    },
    get(id) {
      return byId.get(id);
    },
    resolve(env, id) {
      const definition = byId.get(id);
      if (!definition) {
        return {
          ok: false,
          error: {
            code: "unknown_configuration",
            message: `Unknown ASR configuration ${quoteId(id)}`,
          },
        };
      }
      return definition.resolve(env);
    },
  };
}
