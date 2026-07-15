import { buildConfigurationId, createDefaultConfigurationCatalogue } from "vxasr";
import type { ASRConfigurationCatalogue, ASRProvider, ProviderEnv } from "vxasr";

/** Provider used when `ASR_PROVIDER` is unset — the historical default. */
export const DEFAULT_PRIMARY_PROVIDER_ID = "qwen";

export type SelectionErrorCode = "unknown_configuration" | "not_enabled" | "not_configured";

export interface ConfigurationSelection {
  /** Fully decorated — the configuration owns its post-processing chain. */
  provider: ASRProvider;
  configurationId: string;
}

export type SelectionResult =
  | { ok: true; selection: ConfigurationSelection }
  | { ok: false; code: SelectionErrorCode; message: string };

export interface SelectionRequest {
  /** The `?configuration=` query param, if the client sent a non-empty one. */
  configuration?: string | undefined;
}

export interface ConfigurationSelector {
  readonly defaultConfigurationId: string;
  /** Configurations a client may name in `?configuration=`. */
  readonly enabledConfigurationIds: readonly string[];
  select(request: SelectionRequest): SelectionResult;
}

/**
 * A websocket close reason may not exceed 123 bytes — `ws.close()` throws past
 * that. Every rejection here becomes a close reason, and some of them quote a
 * client-supplied id, so clamp them all at the boundary.
 */
const MAX_CLOSE_REASON_BYTES = 123;

function clampReason(message: string): string {
  let clamped = message;
  while (Buffer.byteLength(clamped, "utf8") > MAX_CLOSE_REASON_BYTES) {
    clamped = clamped.slice(0, -1);
  }
  return clamped;
}

function reject(code: SelectionErrorCode, message: string): SelectionResult {
  return { ok: false, code, message: clampReason(message) };
}

function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Works out which configuration a session uses when the client names none.
 *
 * `ASR_CONFIGURATION` names one outright. Otherwise the id is derived from the
 * older `ASR_PROVIDER`/`ASR_MODEL` pair, which predates configurations and must
 * keep behaving exactly as it did: back then `GROQ_API_KEY` being set was what
 * enhanced the primary, so its presence selects the `+groq` configuration when
 * one exists for that provider and model.
 *
 * `ASR_PROVIDER=mock` needs no special case. Enhancement now lives in the
 * catalogue, and no `mock/mock+groq` configuration is declared, so the lookup
 * below simply misses and falls through to the raw mock — the same "a fake is
 * never wrapped in a real LLM call" behaviour, now structural.
 */
function deriveDefaultConfigurationId(
  env: ProviderEnv,
  catalogue: ASRConfigurationCatalogue,
): string {
  if (env.ASR_CONFIGURATION) {
    if (!catalogue.get(env.ASR_CONFIGURATION)) {
      throw new Error(
        `ASR_CONFIGURATION="${env.ASR_CONFIGURATION}" is not a known ASR configuration ` +
          `(known: ${catalogue.ids.join(", ")})`,
      );
    }
    return env.ASR_CONFIGURATION;
  }

  const providerId = env.ASR_PROVIDER || DEFAULT_PRIMARY_PROVIDER_ID;
  const provider = catalogue.providers.get(providerId);
  if (!provider) {
    throw new Error(
      `ASR_PROVIDER="${providerId}" is not a known ASR provider ` +
        `(known: ${catalogue.providers.ids.join(", ")})`,
    );
  }

  const model = env.ASR_MODEL || provider.defaultModel;
  if (env.GROQ_API_KEY) {
    const enhanced = buildConfigurationId(providerId, model, ["groq"]);
    if (catalogue.get(enhanced)) return enhanced;
  }

  const raw = buildConfigurationId(providerId, model);
  if (!catalogue.get(raw)) {
    throw new Error(
      `No ASR configuration for ASR_PROVIDER="${providerId}" ASR_MODEL="${model}" ` +
        `(known: ${catalogue.ids.join(", ")})`,
    );
  }
  return raw;
}

/**
 * Resolves a WS request into an {@link ASRProvider}.
 *
 * A client either names a configuration via `?configuration=` or gets the
 * env-configured default. There is no enhancement branch here: a configuration
 * carries its own post-processing chain, so the default configuration is just
 * one of the candidates an eval compares, on the same terms as the rest.
 *
 * Throws only on server misconfiguration, at startup, never per-request.
 */
export function createConfigurationSelector(
  env: ProviderEnv,
  catalogue: ASRConfigurationCatalogue = createDefaultConfigurationCatalogue(),
): ConfigurationSelector {
  const defaultConfigurationId = deriveDefaultConfigurationId(env, catalogue);

  // `ASR_CONFIGURATIONS` is an explicit allowlist; without it, anything the
  // environment carries credentials for is selectable. The default is always
  // selectable so that naming it can never contradict the default path.
  const configured = parseList(env.ASR_CONFIGURATIONS);
  for (const id of configured) {
    if (!catalogue.get(id)) {
      throw new Error(
        `ASR_CONFIGURATIONS lists unknown ASR configuration "${id}" ` +
          `(known: ${catalogue.ids.join(", ")})`,
      );
    }
  }
  const enabled = new Set(
    configured.length > 0
      ? configured
      : catalogue
          .list()
          .flatMap((definition) => (definition.isConfigured(env) ? [definition.id] : [])),
  );
  enabled.add(defaultConfigurationId);

  return {
    defaultConfigurationId,
    enabledConfigurationIds: [...enabled],

    select(request) {
      const explicit = request.configuration !== undefined;
      const id = request.configuration ?? defaultConfigurationId;

      if (!catalogue.get(id)) {
        return reject("unknown_configuration", `Unknown ASR configuration "${id}"`);
      }
      if (explicit && !enabled.has(id)) {
        return reject("not_enabled", `ASR configuration "${id}" is not enabled`);
      }

      const resolution = catalogue.resolve(env, id);
      if (!resolution.ok) {
        const { error } = resolution;
        if (error.code === "not_configured") {
          // Phrased as it was before configurations existed, so an operator
          // hitting a missing key still reads "DASHSCOPE_API_KEY not configured".
          const missing = error.missing ?? [];
          return reject(
            "not_configured",
            missing.length > 0 ? `${missing.join(", ")} not configured` : error.message,
          );
        }
        return reject(error.code, error.message);
      }

      return {
        ok: true,
        selection: {
          provider: resolution.provider,
          configurationId: resolution.configurationId,
        },
      };
    },
  };
}
