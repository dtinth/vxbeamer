import {
  createProviderRegistry,
  defineProvider,
  type ASRProviderRegistry,
  type ProviderDefinition,
} from "../registry.ts";
import { createQwenProvider, type QwenProviderConfig } from "./qwen.ts";
import { createBytePlusProvider, type BytePlusProviderConfig } from "./byteplus.ts";
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
  resolveConfig(env) {
    const apiKey = env.DASHSCOPE_API_KEY;
    if (!apiKey) return { ok: false, missing: ["DASHSCOPE_API_KEY"] };
    return { ok: true, config: { apiKey } };
  },
  create(config, model) {
    return createQwenProvider({ ...config, model });
  },
});

export const bytePlusProviderDefinition: ProviderDefinition =
  defineProvider<BytePlusProviderConfig>({
    id: "byteplus",
    label: "BytePlus (Seed-ASR)",
    models: ["bigmodel"],
    resolveConfig(env) {
      const apiKey = env.BYTEPLUS_API_KEY;
      if (!apiKey) return { ok: false, missing: ["BYTEPLUS_API_KEY"] };
      return {
        ok: true,
        config: { apiKey, resourceId: env.BYTEPLUS_RESOURCE_ID, url: env.BYTEPLUS_URL },
      };
    },
    create(config, model) {
      return createBytePlusProvider({ ...config, model });
    },
  });

export const mockProviderDefinition: ProviderDefinition = defineProvider<Record<string, never>>({
  id: "mock",
  label: "Mock (canned transcript, no network)",
  models: ["mock"],
  resolveConfig() {
    return { ok: true, config: {} };
  },
  create() {
    return createMockProvider();
  },
});

export const builtinProviderDefinitions: readonly ProviderDefinition[] = [
  qwenProviderDefinition,
  bytePlusProviderDefinition,
  mockProviderDefinition,
];

export function createDefaultProviderRegistry(): ASRProviderRegistry {
  return createProviderRegistry(builtinProviderDefinitions);
}
