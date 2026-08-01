import { expect, test } from "vite-plus/test";
import { createConfigurationSelector } from "./asr.ts";

// Every model is pinned; there is no floating `qwen3-asr-flash-realtime`.
// 2025-10-27 leads the provider's model list, so it is the derived default —
// which is what the undated id resolved to when it was dropped.
const QWEN = "qwen/qwen3-asr-flash-realtime-2025-10-27";
const QWEN_GROQ = "qwen/qwen3-asr-flash-realtime-2025-10-27+groq";
const QWEN_2026 = "qwen/qwen3-asr-flash-realtime-2026-02-10";
const QWEN_2026_GROQ = "qwen/qwen3-asr-flash-realtime-2026-02-10+groq";
// A separate provider from `qwen` — same vendor and key, different protocol and
// billing — so its models are pinned snapshots too. Flash leads its list.
const OMNI_FLASH = "qwen-omni/qwen3.5-omni-flash-realtime-2026-03-15";

function expectOk(result: ReturnType<ReturnType<typeof createConfigurationSelector>["select"]>) {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.message}`);
  return result.selection;
}

function expectErr(result: ReturnType<ReturnType<typeof createConfigurationSelector>["select"]>) {
  if (result.ok) throw new Error("expected an error");
  return result;
}

// --- Preserving the pre-configuration behaviour exactly ---
//
// Before configurations existed, /ws read ASR_PROVIDER (mock, else qwen) and
// wrapped qwen with Groq whenever GROQ_API_KEY was set. Each case below pins
// one of those branches to its equivalent configuration id.

test("with no env at all, the default is raw qwen", () => {
  const selector = createConfigurationSelector({ DASHSCOPE_API_KEY: "dk" });

  expect(selector.defaultConfigurationId).toBe(QWEN);
  expect(expectOk(selector.select({})).configurationId).toBe(QWEN);
});

test("GROQ_API_KEY makes the default the enhanced qwen configuration", () => {
  const selector = createConfigurationSelector({ DASHSCOPE_API_KEY: "dk", GROQ_API_KEY: "gk" });

  expect(selector.defaultConfigurationId).toBe(QWEN_GROQ);
  expect(expectOk(selector.select({})).configurationId).toBe(QWEN_GROQ);
});

test("ASR_PROVIDER=mock selects the mock configuration", () => {
  const selector = createConfigurationSelector({ ASR_PROVIDER: "mock" });

  expect(expectOk(selector.select({})).configurationId).toBe("mock/mock");
});

test("ASR_PROVIDER=mock stays raw even when GROQ_API_KEY is set", () => {
  // Not a special case: no mock/mock+groq configuration exists to select.
  const selector = createConfigurationSelector({ ASR_PROVIDER: "mock", GROQ_API_KEY: "gk" });

  expect(selector.defaultConfigurationId).toBe("mock/mock");
  expect(expectOk(selector.select({})).configurationId).toBe("mock/mock");
});

test("a missing DASHSCOPE_API_KEY reports the same message as before", () => {
  const selector = createConfigurationSelector({});

  const error = expectErr(selector.select({}));

  expect(error.code).toBe("not_configured");
  expect(error.message).toBe("DASHSCOPE_API_KEY not configured");
});

test("a missing DASHSCOPE_API_KEY reports the same message when Groq is configured", () => {
  const selector = createConfigurationSelector({ GROQ_API_KEY: "gk" });

  expect(expectErr(selector.select({})).message).toBe("DASHSCOPE_API_KEY not configured");
});

// --- The default is just another candidate ---

test("naming the default configuration explicitly gives the same configuration", () => {
  // The asymmetry this design removes: an eval candidate and the primary
  // answer are now the same configuration, so a winner cannot silently
  // downgrade an enhanced transcript to a raw one.
  const selector = createConfigurationSelector({ DASHSCOPE_API_KEY: "dk", GROQ_API_KEY: "gk" });

  expect(selector.defaultConfigurationId).toBe(QWEN_GROQ);
  expect(expectOk(selector.select({ configuration: QWEN_GROQ })).configurationId).toBe(QWEN_GROQ);
});

test("raw and enhanced qwen are separately selectable", () => {
  const selector = createConfigurationSelector({ DASHSCOPE_API_KEY: "dk", GROQ_API_KEY: "gk" });

  expect(expectOk(selector.select({ configuration: QWEN })).configurationId).toBe(QWEN);
  expect(expectOk(selector.select({ configuration: QWEN_GROQ })).configurationId).toBe(QWEN_GROQ);
});

test("a non-qwen configuration is selectable once its credentials exist", () => {
  const selector = createConfigurationSelector({
    DASHSCOPE_API_KEY: "dk",
    BYTEPLUS_API_KEY: "bk",
  });

  expect(
    expectOk(selector.select({ configuration: "byteplus/bigmodel_nostream" })).configurationId,
  ).toBe("byteplus/bigmodel_nostream");
});

// --- ASR_CONFIGURATION ---

test("ASR_CONFIGURATION names the default outright", () => {
  const selector = createConfigurationSelector({
    DASHSCOPE_API_KEY: "dk",
    GROQ_API_KEY: "gk",
    ASR_CONFIGURATION: QWEN,
  });

  // Explicit beats the GROQ_API_KEY-implies-enhanced compatibility rule.
  expect(selector.defaultConfigurationId).toBe(QWEN);
  expect(expectOk(selector.select({})).configurationId).toBe(QWEN);
});

test("ASR_MODEL still feeds the derived default", () => {
  const selector = createConfigurationSelector({
    DASHSCOPE_API_KEY: "dk",
    ASR_MODEL: "qwen3-asr-flash-realtime-2025-10-27",
  });

  expect(selector.defaultConfigurationId).toBe(QWEN);
});

// --- Rejecting bad requests cleanly ---

test("an unknown configuration id is rejected cleanly", () => {
  const selector = createConfigurationSelector({ DASHSCOPE_API_KEY: "dk" });

  const error = expectErr(selector.select({ configuration: "definitely/not-real" }));

  expect(error.code).toBe("unknown_configuration");
  expect(error.message).toContain("definitely/not-real");
});

test("a provider id alone is not a configuration id", () => {
  const selector = createConfigurationSelector({ DASHSCOPE_API_KEY: "dk" });

  expect(expectErr(selector.select({ configuration: "qwen" })).code).toBe("unknown_configuration");
});

test("rejection messages fit in a websocket close reason", () => {
  const selector = createConfigurationSelector({ DASHSCOPE_API_KEY: "dk" });

  const error = expectErr(selector.select({ configuration: "x".repeat(400) }));

  expect(Buffer.byteLength(error.message, "utf8")).toBeLessThanOrEqual(123);
});

// --- Enablement ---

test("a configuration without credentials is not selectable", () => {
  const selector = createConfigurationSelector({ DASHSCOPE_API_KEY: "dk" });

  expect(expectErr(selector.select({ configuration: "byteplus/bigmodel_nostream" })).code).toBe(
    "not_enabled",
  );
  expect(expectErr(selector.select({ configuration: QWEN_GROQ })).code).toBe("not_enabled");
});

test("ASR_CONFIGURATIONS narrows what a client may select", () => {
  const selector = createConfigurationSelector({
    DASHSCOPE_API_KEY: "dk",
    BYTEPLUS_API_KEY: "bk",
    ASR_CONFIGURATIONS: QWEN,
  });

  expect(selector.enabledConfigurationIds).toEqual([QWEN]);
  expect(expectErr(selector.select({ configuration: "byteplus/bigmodel_nostream" })).code).toBe(
    "not_enabled",
  );
});

test("credentials alone make a configuration selectable", () => {
  const selector = createConfigurationSelector({
    DASHSCOPE_API_KEY: "dk",
    BYTEPLUS_API_KEY: "bk",
    GROQ_API_KEY: "gk",
  });

  expect(selector.enabledConfigurationIds).toEqual([
    QWEN,
    QWEN_GROQ,
    QWEN_2026,
    QWEN_2026_GROQ,
    // The Qwen Omni models ride on the same DASHSCOPE_API_KEY as `qwen`, so
    // credentialling one credentials both — they are a separate provider for
    // protocol and billing reasons, not a separate account.
    OMNI_FLASH,
    "qwen-omni/qwen3.5-omni-plus-realtime-2026-03-15",
    "qwen-omni/qwen3-omni-flash-realtime-2025-12-01",
    "byteplus/bigmodel_nostream",
    "byteplus/bigmodel_nostream+groq",
    "mock/mock",
  ]);
});

test("isEnabled answers the same question as select, without building a provider", () => {
  const selector = createConfigurationSelector({
    DASHSCOPE_API_KEY: "dk",
    ASR_CONFIGURATIONS: QWEN,
  });

  expect(selector.isEnabled(QWEN)).toBe(true);
  expect(selector.isEnabled("byteplus/bigmodel_nostream")).toBe(false);
  expect(selector.isEnabled("definitely/not-real")).toBe(false);
});

test("the default is always selectable, even if ASR_CONFIGURATIONS omits it", () => {
  const selector = createConfigurationSelector({
    DASHSCOPE_API_KEY: "dk",
    ASR_CONFIGURATIONS: "mock/mock",
  });

  expect(expectOk(selector.select({ configuration: QWEN })).configurationId).toBe(QWEN);
});

// --- Describing the selectable set (what an eval fans out to) ---

test("every described configuration is one a client may actually select", () => {
  // The contract behind having no separate eval set: the listing and the /ws
  // accept set are the same set, so a fan-out can never name a rejected id.
  const selector = createConfigurationSelector({
    DASHSCOPE_API_KEY: "dk",
    BYTEPLUS_API_KEY: "bk",
    GROQ_API_KEY: "gk",
  });

  for (const descriptor of selector.listConfigurations()) {
    expect(expectOk(selector.select({ configuration: descriptor.id })).configurationId).toBe(
      descriptor.id,
    );
  }
  expect(selector.listConfigurations().map((c) => c.id)).toEqual(selector.enabledConfigurationIds);
});

test("a described configuration carries its identity components and a label", () => {
  const selector = createConfigurationSelector({ DASHSCOPE_API_KEY: "dk", GROQ_API_KEY: "gk" });

  const descriptor = selector.listConfigurations().find((c) => c.id === QWEN_GROQ);

  expect(descriptor).toEqual({
    id: QWEN_GROQ,
    label: "Qwen3-ASR-Flash (2025-10-27) + Groq formatting",
    providerId: "qwen",
    model: "qwen3-asr-flash-realtime-2025-10-27",
    postProcessing: ["groq"],
    supportsFastDump: true,
    configured: true,
  });
});

test("raw and enhanced are described as two distinct entries", () => {
  // They share a provider and a model, so only the id tells them apart.
  const selector = createConfigurationSelector({ DASHSCOPE_API_KEY: "dk", GROQ_API_KEY: "gk" });

  const qwens = selector
    .listConfigurations()
    .filter((c) => c.model === "qwen3-asr-flash-realtime-2025-10-27");

  expect(qwens.map((c) => c.id)).toEqual([QWEN, QWEN_GROQ]);
  expect(qwens.map((c) => c.model)).toEqual([
    "qwen3-asr-flash-realtime-2025-10-27",
    "qwen3-asr-flash-realtime-2025-10-27",
  ]);
});

test("the primary is described as one candidate among the rest", () => {
  const selector = createConfigurationSelector({ DASHSCOPE_API_KEY: "dk", GROQ_API_KEY: "gk" });

  expect(selector.listConfigurations().map((c) => c.id)).toContain(selector.defaultConfigurationId);
});

test("ASR_CONFIGURATIONS narrows what is described", () => {
  const selector = createConfigurationSelector({
    DASHSCOPE_API_KEY: "dk",
    BYTEPLUS_API_KEY: "bk",
    ASR_CONFIGURATIONS: QWEN,
  });

  expect(selector.listConfigurations().map((c) => c.id)).toEqual([QWEN]);
});

test("configurations are described in declared order, not allowlist order", () => {
  const selector = createConfigurationSelector({
    DASHSCOPE_API_KEY: "dk",
    ASR_CONFIGURATIONS: `mock/mock,${QWEN}`,
  });

  expect(selector.listConfigurations().map((c) => c.id)).toEqual([QWEN, "mock/mock"]);
});

test("an allowlisted configuration without credentials is described as unconfigured", () => {
  const selector = createConfigurationSelector({
    DASHSCOPE_API_KEY: "dk",
    ASR_CONFIGURATIONS: `${QWEN},byteplus/bigmodel_nostream`,
  });

  const byId = new Map(selector.listConfigurations().map((c) => [c.id, c]));

  // Listed, so the operator can see the gap — but flagged, so a fan-out can
  // skip it rather than open a socket that immediately closes.
  expect(byId.get("byteplus/bigmodel_nostream")?.configured).toBe(false);
  expect(byId.get(QWEN)?.configured).toBe(true);
  expect(expectErr(selector.select({ configuration: "byteplus/bigmodel_nostream" })).code).toBe(
    "not_configured",
  );
});

test("the default is described as unconfigured rather than omitted", () => {
  // The fresh-clone case: no credentials at all. The default is always listed,
  // so the listing cannot contradict what an unqualified /ws would use.
  const selector = createConfigurationSelector({});

  const byId = new Map(selector.listConfigurations().map((c) => [c.id, c]));

  expect(byId.get(QWEN)?.configured).toBe(false);
});

test("nothing about credentials leaks into a described configuration", () => {
  // Not the values, and not the env var names either — `configured` answers
  // "will this work?" without describing the server's environment.
  const selector = createConfigurationSelector({
    DASHSCOPE_API_KEY: "sk-secret-value",
    ASR_CONFIGURATIONS: `${QWEN},byteplus/bigmodel_nostream`,
  });

  const serialized = JSON.stringify(selector.listConfigurations());

  expect(serialized).not.toContain("sk-secret-value");
  expect(serialized).not.toContain("BYTEPLUS_API_KEY");
  expect(serialized).not.toContain("DASHSCOPE_API_KEY");
  expect(serialized).not.toContain("API_KEY");
});

// --- Startup validation ---

test("a typo'd ASR_PROVIDER fails the boot instead of falling back to qwen", () => {
  expect(() =>
    createConfigurationSelector({ ASR_PROVIDER: "qwenn", DASHSCOPE_API_KEY: "dk" }),
  ).toThrow(/not a known ASR provider/);
});

test("an ASR_MODEL with no configuration fails the boot", () => {
  expect(() => createConfigurationSelector({ DASHSCOPE_API_KEY: "dk", ASR_MODEL: "nope" })).toThrow(
    /No ASR configuration/,
  );
});

test("a typo'd ASR_CONFIGURATION fails the boot", () => {
  expect(() =>
    createConfigurationSelector({ DASHSCOPE_API_KEY: "dk", ASR_CONFIGURATION: "qwen/nope" }),
  ).toThrow(/not a known ASR configuration/);
});

test("a typo'd ASR_CONFIGURATIONS entry fails the boot", () => {
  expect(() =>
    createConfigurationSelector({
      DASHSCOPE_API_KEY: "dk",
      ASR_CONFIGURATIONS: `${QWEN},qwen/bogus`,
    }),
  ).toThrow(/unknown ASR configuration "qwen\/bogus"/);
});
