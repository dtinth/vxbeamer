import {
  createProviderRegistry,
  defineProvider,
  type ASRProviderRegistry,
  type ProviderDefinition,
} from "../registry.ts";
import { createQwenProvider, type QwenProviderConfig } from "./qwen.ts";
import { createQwenOmniProvider, type QwenOmniProviderConfig } from "./qwen-omni.ts";
import { createBytePlusProvider, type BytePlusProviderConfig } from "./byteplus.ts";
import { createOpenAIProvider, OPENAI_DEFAULT_MODEL, type OpenAIProviderConfig } from "./openai.ts";
import {
  createOpenRouterProvider,
  OPENROUTER_DEFAULT_MODEL,
  type OpenRouterProviderConfig,
} from "./openrouter.ts";
import {
  createMetaMuseProvider,
  META_MUSE_DEFAULT_MODEL,
  type MetaMuseProviderConfig,
} from "./meta-muse.ts";
import { createPaxaProvider, PAXA_DEFAULT_MODEL, type PaxaProviderConfig } from "./paxa.ts";
import { createMockProvider } from "./mock.ts";

export const qwenProviderDefinition: ProviderDefinition = defineProvider<QwenProviderConfig>({
  id: "qwen",
  label: "Alibaba Cloud DashScope (Qwen3-ASR-Flash)",
  // Pinned snapshots only. The undated `qwen3-asr-flash-realtime` id floats —
  // DashScope repoints it at a new snapshot without notice — so a transcript
  // it produced last month is not one it would produce today, and a vote cast
  // for it names a moving target. Sibling models show that is not theoretical:
  // Fun-ASR's newest snapshot silently dropped Thai, which a floating id would
  // have delivered as a language quietly ceasing to work.
  //
  // The first entry is this provider's default model, so it is what the
  // ASR_PROVIDER/ASR_MODEL compatibility shim derives the primary from.
  // 2025-10-27 leads because it is what the floating id resolved to when it
  // was dropped: the primary's behaviour is unchanged, only pinned.
  models: ["qwen3-asr-flash-realtime-2025-10-27", "qwen3-asr-flash-realtime-2026-02-10"],
  // Confirmed against testdata/OBSERVATIONS.md, "fast dump vs realtime".
  supportsFastDump: true,
  resolveConfig(env) {
    const apiKey = env.DASHSCOPE_API_KEY;
    if (!apiKey) return { ok: false, missing: ["DASHSCOPE_API_KEY"] };
    return { ok: true, config: { apiKey } };
  },
  create(config, model) {
    return createQwenProvider({ ...config, model });
  },
});

export const qwenOmniProviderDefinition: ProviderDefinition =
  defineProvider<QwenOmniProviderConfig>({
    id: "qwen-omni",
    label: "Alibaba Cloud DashScope (Qwen Omni Realtime)",
    // Same vendor and same key as `qwen`, but a separate provider because it is
    // a separate wire protocol and a separate billing model — see `./qwen-omni.ts`.
    //
    // Pinned snapshots, like `qwen`. The undated ids float, and the vendor's own
    // model list carries dated siblings for all three, so there is nothing to
    // exempt here: `qwen3.5-omni-flash-realtime-2026-03-15`,
    // `qwen3.5-omni-plus-realtime-2026-03-15`, and — for the older generation,
    // which publishes two — `qwen3-omni-flash-realtime-2025-12-01`, the newer,
    // and the one the floating id currently resolves to (verified: it reproduces
    // the floating id's transcript and token counts exactly).
    //
    // Flash leads, so it is the default model: it produced a byte-identical
    // transcript to plus on the test fixture at roughly a third of the cost.
    models: [
      "qwen3.5-omni-flash-realtime-2026-03-15",
      "qwen3.5-omni-plus-realtime-2026-03-15",
      "qwen3-omni-flash-realtime-2025-12-01",
    ],
    // Confirmed against testdata/OBSERVATIONS.md, "fast dump vs realtime".
    supportsFastDump: true,
    resolveConfig(env) {
      const apiKey = env.DASHSCOPE_API_KEY;
      if (!apiKey) return { ok: false, missing: ["DASHSCOPE_API_KEY"] };
      return {
        ok: true,
        config: {
          apiKey,
          stickyLingerMs: env.QWEN_OMNI_STICKY_LINGER_MS
            ? Number(env.QWEN_OMNI_STICKY_LINGER_MS)
            : undefined,
          stickyMaxAudioSeconds: env.QWEN_OMNI_STICKY_MAX_AUDIO_SECONDS
            ? Number(env.QWEN_OMNI_STICKY_MAX_AUDIO_SECONDS)
            : undefined,
        },
      };
    },
    create(config, model) {
      return createQwenOmniProvider({ ...config, model });
    },
  });

export const bytePlusProviderDefinition: ProviderDefinition =
  defineProvider<BytePlusProviderConfig>({
    id: "byteplus",
    label: "BytePlus (Seed-ASR)",
    // BytePlus's two modes are different endpoints that hear different
    // languages, so they are modelled as two models: a configuration id has to
    // be able to name which one a vote was cast for. `bigmodel_nostream` leads
    // because it is the only one that accepts a language, and so the only one
    // that can transcribe anything outside its Chinese/English default set.
    // `bigmodel` stays served but is not declared as a configuration — see
    // `../builtin.ts`.
    models: ["bigmodel_nostream", "bigmodel"],
    // Confirmed for `bigmodel_nostream` only (testdata/OBSERVATIONS.md, "fast
    // dump vs realtime") — the only model this provider actually declares as a
    // configuration, so the only one a fast-dump caller can ever reach. The
    // other model, bi-directional `bigmodel`, hangs outright on a fast dump;
    // it stays un-declared for exactly that reason (see the comment above),
    // so this flag never gets a chance to mislead a caller about it.
    supportsFastDump: true,
    resolveConfig(env) {
      const apiKey = env.BYTEPLUS_API_KEY;
      if (!apiKey) return { ok: false, missing: ["BYTEPLUS_API_KEY"] };
      return {
        ok: true,
        config: {
          apiKey,
          // Provider-specific rather than a shared ASR_LANGUAGE: the map lists
          // per-provider language configuration as unspecified, and the value
          // space is the vendor's own (BytePlus wants `th-TH`; Qwen takes no
          // language at all and auto-detects). A cross-provider variable would
          // settle that question for every vendor as a side effect of this fix.
          language: env.BYTEPLUS_LANGUAGE,
          resourceId: env.BYTEPLUS_RESOURCE_ID,
          baseUrl: env.BYTEPLUS_BASE_URL,
        },
      };
    },
    create(config, model) {
      return createBytePlusProvider({ ...config, model });
    },
  });

export const openAIProviderDefinition: ProviderDefinition = defineProvider<OpenAIProviderConfig>({
  id: "openai",
  label: "OpenAI (Realtime Transcription)",
  // One model, tried live against the real endpoint (dtinth/vxbeamer#86):
  // `gpt-live-transcribe` is what the vendor names for exactly this use case
  // (low-latency streaming transcript deltas). `gpt-transcribe` exists too, but
  // is a different, post-commit-only model this adapter has not spoken to —
  // adding it here would be a claim this package cannot back up yet.
  models: [OPENAI_DEFAULT_MODEL],
  // Not yet fast-dump tested against testdata/OBSERVATIONS.md — defaults to
  // realtime pacing until it earns this the same way the others did.
  supportsFastDump: false,
  resolveConfig(env) {
    const apiKey = env.OPENAI_API_KEY;
    if (!apiKey) return { ok: false, missing: ["OPENAI_API_KEY"] };
    return { ok: true, config: { apiKey } };
  },
  create(config, model) {
    return createOpenAIProvider({ ...config, model });
  },
});

export const openRouterProviderDefinition: ProviderDefinition =
  defineProvider<OpenRouterProviderConfig>({
    id: "openrouter",
    label: "OpenRouter",
    // Each tried live against the real endpoint on the same fixture
    // testdata/OBSERVATIONS.md uses (dtinth/vxbeamer#86). The order has
    // changed twice, and the second time is the instructive one:
    // `mai-transcribe-1.5` led originally, then `muse-voice-transcribe-1.0`
    // took the lead on transcript quality alone — and was later found to be
    // **four times slower** than the others (3.9 s vs 0.95 s on a 13 s clip)
    // and the worst transcript of the three when they were finally compared
    // head to head. It had never been timed.
    //
    // `mai-transcribe-2` now leads: fastest, cheapest, and its transcript on
    // that clip was identical to the best of them. The two small errors that
    // once kept it a second choice turned out to be shared by every model
    // that gets the rest of the fixture right, so they no longer separate it
    // from anything.
    //
    // Add another id here once it has been run against that fixture too —
    // and timed, not only read.
    models: [
      OPENROUTER_DEFAULT_MODEL,
      "meta/muse-voice-transcribe-1.0",
      "microsoft/mai-transcribe-1.5",
    ],
    // A batch HTTP call, not a realtime stream — every audio chunk is only
    // ever buffered client-side, so no pace at which `sendAudio` is called
    // can violate anything the vendor sees on the wire.
    supportsFastDump: true,
    resolveConfig(env) {
      const apiKey = env.OPENROUTER_API_KEY;
      if (!apiKey) return { ok: false, missing: ["OPENROUTER_API_KEY"] };
      return { ok: true, config: { apiKey } };
    },
    create(config, model) {
      return createOpenRouterProvider({ ...config, model });
    },
  });

export const metaProviderDefinition: ProviderDefinition = defineProvider<MetaMuseProviderConfig>({
  id: "meta",
  label: "Meta (Realtime Voice Transcribe)",
  // The same model OpenRouter offers as `meta/muse-voice-transcribe-1.0`, but
  // spoken to directly: Meta's own endpoint is a genuine realtime stream with
  // partial transcripts, where OpenRouter's is batch-only (see ./meta-muse.ts).
  models: [META_MUSE_DEFAULT_MODEL],
  // A real streaming protocol, not yet fast-dump tested against
  // testdata/OBSERVATIONS.md — defaults to realtime pacing until it earns this
  // the same way the others did.
  supportsFastDump: false,
  resolveConfig(env) {
    const apiKey = env.META_API_KEY;
    if (!apiKey) return { ok: false, missing: ["META_API_KEY"] };
    return { ok: true, config: { apiKey } };
  },
  create(config, model) {
    return createMetaMuseProvider({ ...config, model });
  },
});

export const paxaProviderDefinition: ProviderDefinition = defineProvider<PaxaProviderConfig>({
  id: "paxa",
  label: "Paxa Labs (Speech-to-Text)",
  // One model, which is all the vendor publishes for this endpoint. The id
  // carries its own `-preview` rather than a date, so there is no dated
  // snapshot to pin to — same situation as BytePlus's mode ids.
  models: [PAXA_DEFAULT_MODEL],
  // A batch HTTP call, not a realtime stream — audio is buffered client-side
  // either way, so no send pace can violate anything the vendor sees.
  supportsFastDump: true,
  resolveConfig(env) {
    const apiKey = env.PAXA_API_KEY;
    if (!apiKey) return { ok: false, missing: ["PAXA_API_KEY"] };
    return {
      ok: true,
      config: {
        apiKey,
        // `spoken` vs `written` changes how numbers and repeated words are
        // written. Left to the vendor's default unless an operator asks,
        // because the difference is invisible on clips without numbers and
        // picking one for everybody would be a guess (dtinth/vxbeamer#86).
        convention: env.PAXA_CONVENTION === "written" ? "written" : undefined,
      },
    };
  },
  create(config, model) {
    return createPaxaProvider({ ...config, model });
  },
});

export const mockProviderDefinition: ProviderDefinition = defineProvider<Record<string, never>>({
  id: "mock",
  label: "Mock (canned transcript, no network)",
  models: ["mock"],
  // No vendor socket behind it, so there is no send pace to violate.
  supportsFastDump: true,
  resolveConfig() {
    return { ok: true, config: {} };
  },
  create() {
    return createMockProvider();
  },
});

export const builtinProviderDefinitions: readonly ProviderDefinition[] = [
  qwenProviderDefinition,
  qwenOmniProviderDefinition,
  bytePlusProviderDefinition,
  openAIProviderDefinition,
  openRouterProviderDefinition,
  metaProviderDefinition,
  paxaProviderDefinition,
  mockProviderDefinition,
];

export function createDefaultProviderRegistry(): ASRProviderRegistry {
  return createProviderRegistry(builtinProviderDefinitions);
}
