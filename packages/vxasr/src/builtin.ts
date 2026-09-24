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
  // The Qwen Omni realtime models. Declared **raw only, no `+groq`**: the
  // enhancement exists to tidy an ASR model's output, and these do not need
  // tidying — they already render Thai words in Thai and product names in
  // Latin, which is the shape the enhancement was reaching for. Groq measurably
  // added nothing to Qwen ASR's cleaner output, and this is cleaner still, so a
  // `+groq` variant here would be a second LLM call bought with a vote slot.
  //
  // All three generations are offered because they genuinely differ, and which
  // one is better is exactly what a vote is for: the 3.5 pair produced a
  // byte-identical transcript on the test fixture, while `qwen3-omni-flash`
  // rendered `Project`/`framework` in Latin where they render Thai. Cost
  // separates the 3.5 pair (plus is ~3.6x flash for the same output on one
  // clip) — but one 9-second clip is not a verdict, which is the whole reason
  // the eval loop exists.
  {
    provider: "qwen-omni",
    model: "qwen3.5-omni-flash-realtime-2026-03-15",
    label: "Qwen3.5-Omni-Flash Realtime (2026-03-15, raw)",
  },
  {
    provider: "qwen-omni",
    model: "qwen3.5-omni-plus-realtime-2026-03-15",
    label: "Qwen3.5-Omni-Plus Realtime (2026-03-15, raw)",
  },
  {
    provider: "qwen-omni",
    model: "qwen3-omni-flash-realtime-2025-12-01",
    label: "Qwen3-Omni-Flash Realtime (2025-12-01, raw)",
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
  // `gpt-live-transcribe`, tried live against the real endpoint
  // (dtinth/vxbeamer#86). Declared **raw only**, same reasoning as Qwen Omni:
  // on the test fixture it rendered every English loanword in Latin script and
  // everything else in Thai, unprompted — the shape the Groq enhancement
  // exists to reach. Unlike Qwen's models, this id is not a dated snapshot:
  // OpenAI does not publish dated variants of it the way DashScope does, so
  // there is nothing to pin to — same situation as BytePlus's mode ids.
  { provider: "openai", label: "OpenAI gpt-live-transcribe (raw)" },
  // Every OpenRouter entry names its model explicitly, including the one that
  // is currently the provider's default. Relying on omission would tie a
  // configuration id to whichever model happens to lead the list, so
  // reordering that list — which has now happened twice — would silently
  // rename a configuration and orphan any vote cast for it
  // (dtinth/vxbeamer#86).
  //
  // Declared raw only, all three: a plain transcription endpoint with no
  // post-processing chain to enhance.
  //
  // `mai-transcribe-2` leads on speed and cost, measured head to head rather
  // than inferred — see the models list in `./providers/builtin.ts`.
  {
    provider: "openrouter",
    model: "microsoft/mai-transcribe-2",
    label: "OpenRouter MAI-Transcribe-2 (raw)",
  },
  // Held the default on transcript quality until it was timed: four times
  // slower than the other two, and the worst of the three on the clip that
  // finally compared them directly.
  {
    provider: "openrouter",
    model: "meta/muse-voice-transcribe-1.0",
    label: "OpenRouter Muse Voice Transcribe (raw)",
  },
  // The original choice, from a live comparison of 19 OpenRouter STT models
  // on the test fixture (dtinth/vxbeamer#86).
  {
    provider: "openrouter",
    model: "microsoft/mai-transcribe-1.5",
    label: "OpenRouter MAI-Transcribe-1.5 (raw)",
  },
  // Paxa Labs, tried live on the same fixtures (dtinth/vxbeamer#86). The only
  // model compared there that needed no instruction to behave: no filler
  // tags, no spaces inserted between Thai words, no English translated into
  // Thai, and byte-identical output across repeated runs. Batch, like
  // OpenRouter, and about four times the price of `mai-transcribe-2` for
  // near-identical speed — a real trade rather than a replacement, which is
  // why it is offered alongside rather than as the default.
  { provider: "paxa", label: "Paxa STT Lite (raw)" },
  // Its realtime sibling (dtinth/vxbeamer#86): the final arrives about 55 ms
  // after the recording ends, against 0.6–0.9 s for the batch call, because
  // the vendor detects the end of speech itself. It costs 1.5× the batch
  // rate, and the whole connection is charged, silence included.
  {
    provider: "paxa",
    model: "paxa-stt-lite-realtime-v1-preview",
    label: "Paxa STT Lite Realtime (raw)",
  },
  // The same model as the OpenRouter default above, spoken to directly
  // (dtinth/vxbeamer#86): Meta's own endpoint streams genuine partial
  // transcripts, where OpenRouter's is a batch upload with no partials.
  // Declared raw only, same reasoning as the OpenRouter entry: a plain
  // transcription endpoint with no post-processing chain to enhance.
  { provider: "meta", label: "Meta Realtime Muse Voice Transcribe (raw)" },
  { provider: "mock", label: "Mock (canned transcript, no network)" },
];

export function createDefaultConfigurationCatalogue(): ASRConfigurationCatalogue {
  return createConfigurationCatalogue({
    providers: createDefaultProviderRegistry(),
    decorators: builtinDecorators,
    configurations: builtinConfigurations,
  });
}
