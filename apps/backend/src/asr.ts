import { createDefaultProviderRegistry, withGroqEnhancement } from "vxasr";
import type { ASRProvider, ASRProviderRegistry, ProviderEnv } from "vxasr";

/** Provider used when `ASR_PROVIDER` is unset — the historical default. */
export const DEFAULT_PRIMARY_PROVIDER_ID = "qwen";

export type SelectionErrorCode =
  | "unknown_provider"
  | "unknown_model"
  | "not_enabled"
  | "not_configured";

export interface ProviderSelection {
  provider: ASRProvider;
  providerId: string;
  model: string;
  /** Whether `withGroqEnhancement` wraps the provider. */
  enhanced: boolean;
}

export type SelectionResult =
  | { ok: true; selection: ProviderSelection }
  | { ok: false; code: SelectionErrorCode; message: string };

export interface SelectionRequest {
  /** The `?provider=` query param, if the client sent a non-empty one. */
  provider?: string | undefined;
  /** The `?model=` query param, if the client sent a non-empty one. */
  model?: string | undefined;
}

export interface ProviderSelector {
  readonly primaryProviderId: string;
  readonly primaryModel: string | undefined;
  /** Providers a client may name in `?provider=`. */
  readonly enabledProviderIds: readonly string[];
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
 * Resolves a WS request into an {@link ASRProvider}.
 *
 * Two paths:
 *
 * - **Primary** (neither `?provider=` nor `?model=` given): use the
 *   env-configured `ASR_PROVIDER`/`ASR_MODEL`, wrapped with
 *   `withGroqEnhancement` when `GROQ_API_KEY` is set. This is what every
 *   existing client hits, and it behaves exactly as it did before the registry.
 * - **Explicit** (either param given): resolve through the registry and return
 *   the model's raw output — no enhancement, because the point of naming a
 *   model is to see what that model produces (head-to-head eval).
 *
 * Throws only on server misconfiguration, at startup, never per-request.
 */
export function createProviderSelector(
  env: ProviderEnv,
  registry: ASRProviderRegistry = createDefaultProviderRegistry(),
): ProviderSelector {
  const primaryProviderId = env.ASR_PROVIDER || DEFAULT_PRIMARY_PROVIDER_ID;
  const primaryModel = env.ASR_MODEL || undefined;

  if (!registry.get(primaryProviderId)) {
    throw new Error(
      `ASR_PROVIDER="${primaryProviderId}" is not a known ASR provider ` +
        `(known: ${registry.ids.join(", ")})`,
    );
  }

  // `ASR_PROVIDERS` is an explicit allowlist; without it, anything the
  // environment carries credentials for is selectable. The primary is always
  // selectable so that `?provider=<primary>` can never contradict the default.
  const configured = parseList(env.ASR_PROVIDERS);
  for (const id of configured) {
    if (!registry.get(id)) {
      throw new Error(
        `ASR_PROVIDERS lists unknown ASR provider "${id}" (known: ${registry.ids.join(", ")})`,
      );
    }
  }
  const enabled = new Set(
    configured.length > 0
      ? configured
      : registry
          .list()
          .flatMap((definition) => (definition.isConfigured(env) ? [definition.id] : [])),
  );
  enabled.add(primaryProviderId);

  return {
    primaryProviderId,
    primaryModel,
    enabledProviderIds: [...enabled],

    select(request) {
      const explicit = request.provider !== undefined || request.model !== undefined;
      const providerId = request.provider ?? primaryProviderId;
      // An explicit provider with no model gets that provider's own default,
      // not the primary's model — the two providers' model ids are unrelated.
      const model = request.model ?? (request.provider === undefined ? primaryModel : undefined);

      const definition = registry.get(providerId);
      if (!definition) {
        return reject("unknown_provider", `Unknown ASR provider "${providerId}"`);
      }
      if (explicit && !enabled.has(providerId)) {
        return reject("not_enabled", `ASR provider "${providerId}" is not enabled`);
      }

      const resolution = registry.resolve(env, { provider: providerId, model });
      if (!resolution.ok) {
        const { error } = resolution;
        if (error.code === "not_configured") {
          // Phrased as it was before the registry existed, so an operator
          // hitting a missing key still reads "DASHSCOPE_API_KEY not configured".
          const missing = error.missing ?? [];
          return reject(
            "not_configured",
            missing.length > 0 ? `${missing.join(", ")} not configured` : error.message,
          );
        }
        return reject(error.code, error.message);
      }

      const groqApiKey = env.GROQ_API_KEY;
      const enhance = !explicit && !!groqApiKey && definition.enhanceable;
      return {
        ok: true,
        selection: {
          provider: enhance
            ? withGroqEnhancement(resolution.provider, { apiKey: groqApiKey })
            : resolution.provider,
          providerId: resolution.providerId,
          model: resolution.model,
          enhanced: enhance,
        },
      };
    },
  };
}
