import { expect, test } from "vite-plus/test";
import {
  createDefaultProviderRegistry,
  createProviderRegistry,
  defineProvider,
  type ASRProvider,
} from "../src";

const fakeProvider: ASRProvider = { createSession: () => ({ sendAudio() {}, finish() {} }) };

/** A provider whose config is deliberately not `{ apiKey }`. */
function defineRegionProvider(seen: { config?: unknown; model?: string }) {
  return defineProvider<{ key: string; region: string }>({
    id: "region",
    label: "Region-scoped provider",
    models: ["big", "small"],
    resolveConfig(env) {
      const missing = ["REGION_KEY", "REGION_LOCATION"].filter((name) => !env[name]);
      if (missing.length > 0) return { ok: false, missing };
      return { ok: true, config: { key: env.REGION_KEY!, region: env.REGION_LOCATION! } };
    },
    create(config, model) {
      seen.config = config;
      seen.model = model;
      return fakeProvider;
    },
  });
}

test("a provider may declare a config shape that is not just an api key", () => {
  const seen: { config?: unknown; model?: string } = {};
  const registry = createProviderRegistry([defineRegionProvider(seen)]);

  const result = registry.resolve(
    { REGION_KEY: "k", REGION_LOCATION: "ap-southeast-1" },
    { provider: "region" },
  );

  expect(result.ok).toBe(true);
  expect(seen.config).toEqual({ key: "k", region: "ap-southeast-1" });
});

test("missing credentials are reported by name rather than throwing", () => {
  const registry = createProviderRegistry([defineRegionProvider({})]);

  const result = registry.resolve({ REGION_KEY: "k" }, { provider: "region" });

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.error.code).toBe("not_configured");
  expect(result.error.missing).toEqual(["REGION_LOCATION"]);
});

test("an unregistered provider id resolves to an error instead of throwing", () => {
  const registry = createProviderRegistry([defineRegionProvider({})]);

  const result = registry.resolve({}, { provider: "does-not-exist" });

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.error.code).toBe("unknown_provider");
  expect(result.error.message).toContain("does-not-exist");
});

test("a model outside the allowlist is rejected", () => {
  const registry = createProviderRegistry([defineRegionProvider({})]);

  const result = registry.resolve(
    { REGION_KEY: "k", REGION_LOCATION: "r" },
    { provider: "region", model: "enormous" },
  );

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.error.code).toBe("unknown_model");
});

test("the model is validated before credentials are read", () => {
  const registry = createProviderRegistry([defineRegionProvider({})]);

  const result = registry.resolve({}, { provider: "region", model: "enormous" });

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.error.code).toBe("unknown_model");
});

test("omitting the model selects the first declared model", () => {
  const seen: { config?: unknown; model?: string } = {};
  const registry = createProviderRegistry([defineRegionProvider(seen)]);

  const result = registry.resolve(
    { REGION_KEY: "k", REGION_LOCATION: "r" },
    { provider: "region" },
  );

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  expect(result.model).toBe("big");
  expect(seen.model).toBe("big");
});

test("registering the same id twice is a programming error", () => {
  expect(() =>
    createProviderRegistry([defineRegionProvider({}), defineRegionProvider({})]),
  ).toThrow(/Duplicate/);
});

test("the default registry exposes qwen, byteplus and mock", () => {
  expect(createDefaultProviderRegistry().ids).toEqual(["qwen", "byteplus", "mock"]);
});

test("byteplus is reachable through the default registry", () => {
  const registry = createDefaultProviderRegistry();

  const result = registry.resolve({ BYTEPLUS_API_KEY: "bp-key" }, { provider: "byteplus" });

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  expect(result.model).toBe("bigmodel");
  expect(typeof result.provider.createSession).toBe("function");
});

test("qwen reports its own env var when unconfigured", () => {
  const result = createDefaultProviderRegistry().resolve({}, { provider: "qwen" });

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.error.missing).toEqual(["DASHSCOPE_API_KEY"]);
});

test("mock needs no credentials and opts out of enhancement", () => {
  const registry = createDefaultProviderRegistry();

  expect(registry.get("mock")?.isConfigured({})).toBe(true);
  expect(registry.get("mock")?.enhanceable).toBe(false);
  expect(registry.get("qwen")?.enhanceable).toBe(true);
});
