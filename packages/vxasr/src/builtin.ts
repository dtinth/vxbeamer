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
 * evaluate: a vote for a raw model says something different from a vote for the
 * enhanced one, and the winner of an eval replaces the primary answer, so both
 * must be comparable on equal terms.
 *
 * **Every model here is pinned to a dated snapshot.** Undated ids float —
 * the vendor repoints them without notice — which would make a vote name a
 * moving target and let a transcript change with nothing in this repo
 * changing. That is not theoretical: Fun-ASR's newest snapshot dropped Thai
 * outright, so a floating id there would have delivered a language quietly
 * ceasing to work.
 *
 * There is deliberately no `mock/mock+groq`: the mock provider is a fake that
 * exists to keep runs hermetic, and pairing it with a real Groq call would
 * defeat that. Its absence from this list *is* the guarantee — no flag, and no
 * branch anywhere in selection can wrap it by accident.
 */
export const builtinConfigurations: readonly ConfigurationSpec[] = [
  // 2025-10-27 is the default (first in the provider's model list), so the
  // enhanced variant is what the primary resolves to when GROQ_API_KEY is set.
  {
    provider: "qwen",
    model: "qwen3-asr-flash-realtime-2025-10-27",
    label: "Qwen3-ASR-Flash (2025-10-27, raw)",
  },
  {
    provider: "qwen",
    model: "qwen3-asr-flash-realtime-2025-10-27",
    postProcessing: ["groq"],
    label: "Qwen3-ASR-Flash (2025-10-27) + Groq formatting",
  },
  {
    provider: "qwen",
    model: "qwen3-asr-flash-realtime-2026-02-10",
    label: "Qwen3-ASR-Flash (2026-02-10, raw)",
  },
  {
    provider: "qwen",
    model: "qwen3-asr-flash-realtime-2026-02-10",
    postProcessing: ["groq"],
    label: "Qwen3-ASR-Flash (2026-02-10) + Groq formatting",
  },
  // `byteplus/bigmodel_nostream`, the mode that accepts a language. The
  // bi-directional `bigmodel` mode is deliberately NOT declared: it cannot be
  // given a language, so outside its Chinese/English default set it returns
  // confident nonsense rather than a bad-but-honest transcript. An eval
  // candidate that cannot hear the speaker's language is not a candidate, it is
  // a wasted vendor call — and `bigmodel+groq` was worse still, because the
  // enhancement rewrites the nonsense into fluent prose that reads like a real
  // answer. The provider still serves the model, so a Chinese/English deployment
  // can declare a configuration for it without touching the adapter.
  //
  // Unlike Qwen, these ids name *modes*, not versions: BytePlus publishes no
  // dated snapshots to pin to, so there is no floating id to avoid here.
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
