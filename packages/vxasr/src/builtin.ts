import {
  createConfigurationCatalogue,
  defineDecorator,
  type ASRConfigurationCatalogue,
  type ConfigurationSpec,
  type DecoratorDefinition,
} from "./configuration.ts";
import { createDefaultProviderRegistry } from "./providers/builtin.ts";
import { withGroqEnhancement, type GroqEnhancementConfig } from "./providers/groq-enhancement.ts";

export const groqDecorator: DecoratorDefinition = defineDecorator<GroqEnhancementConfig>({
  id: "groq",
  resolveConfig(env) {
    const apiKey = env.GROQ_API_KEY;
    if (!apiKey) return { ok: false, missing: ["GROQ_API_KEY"] };
    return { ok: true, config: { apiKey } };
  },
  wrap(provider, config) {
    return withGroqEnhancement(provider, config);
  },
});

export const builtinDecorators: readonly DecoratorDefinition[] = [groqDecorator];

/**
 * The catalogue of selectable model configurations.
 *
 * Raw and enhanced are declared separately because they are separate things to
 * evaluate: a vote for `qwen/qwen3-asr-flash-realtime+groq` says something
 * different from a vote for the raw model, and the winner of an eval replaces
 * the primary answer, so both must be comparable on equal terms.
 *
 * There is deliberately no `mock/mock+groq`: the mock provider is a fake that
 * exists to keep runs hermetic, and pairing it with a real Groq call would
 * defeat that. Its absence from this list *is* the guarantee — no flag, and no
 * branch anywhere in selection can wrap it by accident.
 */
export const builtinConfigurations: readonly ConfigurationSpec[] = [
  { provider: "qwen", label: "Qwen3-ASR-Flash (raw)" },
  { provider: "qwen", postProcessing: ["groq"], label: "Qwen3-ASR-Flash + Groq formatting" },
  // Pinned snapshots of the same model, listed so the undated id's drift is
  // visible rather than inferred. They are declared raw and unenhanced: what
  // differs between snapshots is the recognition, and a formatting layer over
  // the top only obscures it. Enabled by the same DASHSCOPE_API_KEY, so they
  // cost a Qwen run each — narrow with ASR_CONFIGURATIONS to opt out.
  {
    provider: "qwen",
    model: "qwen3-asr-flash-realtime-2026-02-10",
    label: "Qwen3-ASR-Flash (2026-02-10)",
  },
  {
    provider: "qwen",
    model: "qwen3-asr-flash-realtime-2025-10-27",
    label: "Qwen3-ASR-Flash (2025-10-27)",
  },
  { provider: "byteplus", label: "BytePlus Seed-ASR (raw)" },
  { provider: "byteplus", postProcessing: ["groq"], label: "BytePlus Seed-ASR + Groq formatting" },
  { provider: "mock", label: "Mock (canned transcript, no network)" },
];

export function createDefaultConfigurationCatalogue(): ASRConfigurationCatalogue {
  return createConfigurationCatalogue({
    providers: createDefaultProviderRegistry(),
    decorators: builtinDecorators,
    configurations: builtinConfigurations,
  });
}
