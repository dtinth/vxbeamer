import { expect, test } from "vite-plus/test";
import {
  buildConfigurationId,
  createConfigurationCatalogue,
  createDefaultConfigurationCatalogue,
  createProviderRegistry,
  defineDecorator,
  defineProvider,
  type ASRProvider,
} from "../src/index.ts";

function trackingProvider(tag: string): ASRProvider {
  return { createSession: () => ({ sendAudio() {}, finish() {}, tag }) as never };
}

/** Records the decorator chain applied to a provider, in order. */
function tracer() {
  const applied: string[] = [];
  const decorator = (id: string, envVar?: string) =>
    defineDecorator<{ marker: string }>({
      id,
      resolveConfig(env) {
        if (envVar && !env[envVar]) return { ok: false, missing: [envVar] };
        return { ok: true, config: { marker: id } };
      },
      wrap(provider, config) {
        applied.push(config.marker);
        return provider;
      },
    });
  return { applied, decorator };
}

const providers = createProviderRegistry([
  defineProvider<{ key: string }>({
    id: "vendor",
    label: "Vendor",
    models: ["big", "small"],
    supportsFastDump: false,
    resolveConfig(env) {
      if (!env.VENDOR_KEY) return { ok: false, missing: ["VENDOR_KEY"] };
      return { ok: true, config: { key: env.VENDOR_KEY } };
    },
    create: () => trackingProvider("vendor"),
  }),
  defineProvider<Record<string, never>>({
    id: "fake",
    label: "Fake",
    models: ["fake"],
    supportsFastDump: false,
    resolveConfig: () => ({ ok: true, config: {} }),
    create: () => trackingProvider("fake"),
  }),
]);

test("an id is derived from provider, model and chain", () => {
  expect(buildConfigurationId("qwen", "qwen3-asr-flash-realtime")).toBe(
    "qwen/qwen3-asr-flash-realtime",
  );
  expect(buildConfigurationId("qwen", "qwen3-asr-flash-realtime", ["groq"])).toBe(
    "qwen/qwen3-asr-flash-realtime+groq",
  );
});

test("the same model raw and enhanced are two distinct configurations", () => {
  const { decorator } = tracer();
  const catalogue = createConfigurationCatalogue({
    providers,
    decorators: [decorator("enhance")],
    configurations: [{ provider: "vendor" }, { provider: "vendor", postProcessing: ["enhance"] }],
  });

  expect(catalogue.ids).toEqual(["vendor/big", "vendor/big+enhance"]);
});

test("a configuration applies its own chain, in order", () => {
  const { applied, decorator } = tracer();
  const catalogue = createConfigurationCatalogue({
    providers,
    decorators: [decorator("first"), decorator("second")],
    configurations: [{ provider: "vendor", postProcessing: ["first", "second"] }],
  });

  const result = catalogue.resolve({ VENDOR_KEY: "k" }, "vendor/big+first+second");

  expect(result.ok).toBe(true);
  expect(applied).toEqual(["first", "second"]);
});

test("a chain's credentials are part of the configuration's requirements", () => {
  const { decorator } = tracer();
  const catalogue = createConfigurationCatalogue({
    providers,
    decorators: [decorator("enhance", "ENHANCE_KEY")],
    configurations: [{ provider: "vendor", postProcessing: ["enhance"] }],
  });

  const result = catalogue.resolve({ VENDOR_KEY: "k" }, "vendor/big+enhance");

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.error.code).toBe("not_configured");
  expect(result.error.missing).toEqual(["ENHANCE_KEY"]);
});

test("everything missing is reported at once, across provider and chain", () => {
  const { decorator } = tracer();
  const catalogue = createConfigurationCatalogue({
    providers,
    decorators: [decorator("enhance", "ENHANCE_KEY")],
    configurations: [{ provider: "vendor", postProcessing: ["enhance"] }],
  });

  const result = catalogue.resolve({}, "vendor/big+enhance");

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.error.missing).toEqual(["VENDOR_KEY", "ENHANCE_KEY"]);
});

test("a configuration is unconfigured until its whole chain is satisfied", () => {
  const { decorator } = tracer();
  const catalogue = createConfigurationCatalogue({
    providers,
    decorators: [decorator("enhance", "ENHANCE_KEY")],
    configurations: [{ provider: "vendor" }, { provider: "vendor", postProcessing: ["enhance"] }],
  });

  const env = { VENDOR_KEY: "k" };
  expect(catalogue.get("vendor/big")?.isConfigured(env)).toBe(true);
  expect(catalogue.get("vendor/big+enhance")?.isConfigured(env)).toBe(false);
  expect(catalogue.get("vendor/big+enhance")?.isConfigured({ ...env, ENHANCE_KEY: "e" })).toBe(
    true,
  );
});

test("an unknown configuration id resolves to an error instead of throwing", () => {
  const catalogue = createConfigurationCatalogue({
    providers,
    configurations: [{ provider: "vendor" }],
  });

  const result = catalogue.resolve({ VENDOR_KEY: "k" }, "vendor/nope");

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.error.code).toBe("unknown_configuration");
});

// --- The catalogue is code, so bad composition is a boot-time error ---

test("a configuration naming an unknown provider fails at construction", () => {
  expect(() =>
    createConfigurationCatalogue({ providers, configurations: [{ provider: "nope" }] }),
  ).toThrow(/unknown ASR provider/);
});

test("a configuration naming a model the provider does not serve fails at construction", () => {
  expect(() =>
    createConfigurationCatalogue({
      providers,
      configurations: [{ provider: "vendor", model: "enormous" }],
    }),
  ).toThrow(/does not serve model/);
});

test("a configuration naming an unknown decorator fails at construction", () => {
  expect(() =>
    createConfigurationCatalogue({
      providers,
      configurations: [{ provider: "vendor", postProcessing: ["nope"] }],
    }),
  ).toThrow(/unknown decorator/);
});

test("two configurations with the same composition collide", () => {
  expect(() =>
    createConfigurationCatalogue({
      providers,
      configurations: [{ provider: "vendor" }, { provider: "vendor", model: "big" }],
    }),
  ).toThrow(/Duplicate/);
});

// --- The built-in catalogue ---

test("the default catalogue offers each real model, enhanced only where that helps", () => {
  // Every model is pinned — no floating `qwen3-asr-flash-realtime`.
  // The ASR models are offered raw and enhanced, because the enhancement
  // changes their output enough to be worth a vote of its own. The Qwen Omni
  // models are offered raw only: they already produce what the enhancement is
  // reaching for, so a `+groq` sibling would spend an LLM call and a vote slot
  // to change nothing.
  expect(createDefaultConfigurationCatalogue().ids).toEqual([
    "qwen/qwen3-asr-flash-realtime-2025-10-27",
    "qwen/qwen3-asr-flash-realtime-2025-10-27+groq",
    "qwen/qwen3-asr-flash-realtime-2026-02-10",
    "qwen/qwen3-asr-flash-realtime-2026-02-10+groq",
    // Raw only: the Qwen Omni models need no tidying, so no `+groq` sibling.
    "qwen-omni/qwen3.5-omni-flash-realtime-2026-03-15",
    "qwen-omni/qwen3.5-omni-plus-realtime-2026-03-15",
    "qwen-omni/qwen3-omni-flash-realtime-2025-12-01",
    "byteplus/bigmodel_nostream",
    "byteplus/bigmodel_nostream+groq",
    // Raw only, like the Qwen Omni models — tried live, and it renders
    // loanwords in Latin unprompted, so a `+groq` sibling has nothing to add.
    "openai/gpt-live-transcribe",
    "mock/mock",
  ]);
});

test("no configuration names a floating model id", () => {
  // A floating id lets the vendor change a transcript with nothing in this
  // repo changing, which makes a vote name a moving target. Fun-ASR's newest
  // snapshot dropped Thai outright — the same class of change, arriving
  // silently. Every real model here is pinned to a dated snapshot.
  //
  // The Qwen Omni models needed no exemption: the vendor's docs say only to
  // "check the console", but its model list serves dated siblings for all three
  // undated ids, so they are pinned like the rest.
  for (const configuration of createDefaultConfigurationCatalogue().list()) {
    if (configuration.providerId === "mock") continue;
    // BytePlus is exempt because its ids name *modes* (`bigmodel_nostream` is
    // an endpoint, not a version) and the vendor publishes no dated snapshots
    // to pin to. The drift the rule guards against is real here too — there is
    // simply nothing to pin. Revisit if BytePlus ever versions its models.
    if (configuration.providerId === "byteplus") continue;
    // Same situation for OpenAI: `gpt-live-transcribe` is the vendor's whole
    // name for it, with no dated siblings published to pin to instead.
    if (configuration.providerId === "openai") continue;
    expect(configuration.model).toMatch(/-\d{4}-\d{2}-\d{2}$/);
  }
});

test("the bi-directional bigmodel mode is served but not offered as a configuration", () => {
  const catalogue = createDefaultConfigurationCatalogue();

  // It cannot be given a language, so it cannot hear anything outside its
  // Chinese/English default set — nothing to evaluate. The provider still serves
  // it, so a deployment in those languages can declare it.
  expect(catalogue.ids).not.toContain("byteplus/bigmodel");
  expect(catalogue.ids).not.toContain("byteplus/bigmodel+groq");
  expect(catalogue.providers.get("byteplus")?.models).toContain("bigmodel");
});

test("no configuration pairs the mock fake with a real LLM call", () => {
  const catalogue = createDefaultConfigurationCatalogue();

  const mockConfigurations = catalogue.list().filter((c) => c.providerId === "mock");

  expect(mockConfigurations.map((c) => c.id)).toEqual(["mock/mock"]);
  for (const configuration of mockConfigurations) {
    expect(configuration.postProcessing).toEqual([]);
  }
});

test("the enhanced qwen configuration needs both keys", () => {
  const catalogue = createDefaultConfigurationCatalogue();

  expect(catalogue.get("qwen/qwen3-asr-flash-realtime-2025-10-27+groq")?.missingConfig({})).toEqual(
    ["DASHSCOPE_API_KEY", "GROQ_API_KEY"],
  );
  expect(
    catalogue.get("qwen/qwen3-asr-flash-realtime-2025-10-27+groq")?.isConfigured({
      DASHSCOPE_API_KEY: "d",
      GROQ_API_KEY: "g",
    }),
  ).toBe(true);
});

test("a configuration id survives a round trip through URLSearchParams", () => {
  // The `+` in an id decodes to a space unless encoded, so clients must encode.
  const id = "qwen/qwen3-asr-flash-realtime+groq";
  const params = new URLSearchParams();
  params.set("configuration", id);

  expect(params.toString()).toContain("%2B");
  expect(new URLSearchParams(params.toString()).get("configuration")).toBe(id);
});
