import { expect, test } from "vite-plus/test";
import { createConfigurationSelector } from "./asr.ts";

const QWEN = "qwen/qwen3-asr-flash-realtime";
const QWEN_GROQ = "qwen/qwen3-asr-flash-realtime+groq";

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

  expect(expectOk(selector.select({ configuration: "byteplus/bigmodel" })).configurationId).toBe(
    "byteplus/bigmodel",
  );
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
    ASR_MODEL: "qwen3-asr-flash-realtime",
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

  expect(expectErr(selector.select({ configuration: "byteplus/bigmodel" })).code).toBe(
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
  expect(expectErr(selector.select({ configuration: "byteplus/bigmodel" })).code).toBe(
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
    "byteplus/bigmodel",
    "byteplus/bigmodel+groq",
    "mock/mock",
  ]);
});

test("the default is always selectable, even if ASR_CONFIGURATIONS omits it", () => {
  const selector = createConfigurationSelector({
    DASHSCOPE_API_KEY: "dk",
    ASR_CONFIGURATIONS: "mock/mock",
  });

  expect(expectOk(selector.select({ configuration: QWEN })).configurationId).toBe(QWEN);
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
