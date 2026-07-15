import { expect, test } from "vite-plus/test";
import { createProviderSelector } from "./asr.ts";

const QWEN_MODEL = "qwen3-asr-flash-realtime";

function expectOk(result: ReturnType<ReturnType<typeof createProviderSelector>["select"]>) {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.message}`);
  return result.selection;
}

function expectErr(result: ReturnType<ReturnType<typeof createProviderSelector>["select"]>) {
  if (result.ok) throw new Error("expected an error");
  return result;
}

// --- Preserving the pre-registry behaviour ---

test("with no query params and no ASR_PROVIDER, the primary is qwen", () => {
  const selector = createProviderSelector({ DASHSCOPE_API_KEY: "dk" });

  const selection = expectOk(selector.select({}));

  expect(selection.providerId).toBe("qwen");
  expect(selection.model).toBe(QWEN_MODEL);
  expect(selection.enhanced).toBe(false);
});

test("GROQ_API_KEY enhances the primary path", () => {
  const selector = createProviderSelector({ DASHSCOPE_API_KEY: "dk", GROQ_API_KEY: "gk" });

  expect(expectOk(selector.select({})).enhanced).toBe(true);
});

test("ASR_PROVIDER=mock selects the mock provider", () => {
  const selector = createProviderSelector({ ASR_PROVIDER: "mock" });

  const selection = expectOk(selector.select({}));

  expect(selection.providerId).toBe("mock");
  expect(selection.enhanced).toBe(false);
});

test("ASR_PROVIDER=mock stays unenhanced even when GROQ_API_KEY is set", () => {
  const selector = createProviderSelector({ ASR_PROVIDER: "mock", GROQ_API_KEY: "gk" });

  expect(expectOk(selector.select({})).enhanced).toBe(false);
});

test("a missing DASHSCOPE_API_KEY reports the same message as before the registry", () => {
  const selector = createProviderSelector({});

  const error = expectErr(selector.select({}));

  expect(error.code).toBe("not_configured");
  expect(error.message).toBe("DASHSCOPE_API_KEY not configured");
});

// --- Explicit selection ---

test("?provider= selects a non-primary provider", () => {
  const selector = createProviderSelector({ DASHSCOPE_API_KEY: "dk", BYTEPLUS_API_KEY: "bk" });

  const selection = expectOk(selector.select({ provider: "byteplus" }));

  expect(selection.providerId).toBe("byteplus");
  expect(selection.model).toBe("bigmodel");
});

test("an explicitly named provider is never enhanced, so eval sees raw model output", () => {
  const selector = createProviderSelector({
    DASHSCOPE_API_KEY: "dk",
    BYTEPLUS_API_KEY: "bk",
    GROQ_API_KEY: "gk",
  });

  expect(expectOk(selector.select({ provider: "byteplus" })).enhanced).toBe(false);
  expect(expectOk(selector.select({ provider: "qwen" })).enhanced).toBe(false);
  expect(expectOk(selector.select({ model: QWEN_MODEL })).enhanced).toBe(false);
});

test("?model= alone applies to the primary provider", () => {
  const selector = createProviderSelector({ DASHSCOPE_API_KEY: "dk" });

  const selection = expectOk(selector.select({ model: QWEN_MODEL }));

  expect(selection.providerId).toBe("qwen");
  expect(selection.model).toBe(QWEN_MODEL);
});

test("ASR_MODEL sets the primary model", () => {
  const selector = createProviderSelector({ DASHSCOPE_API_KEY: "dk", ASR_MODEL: QWEN_MODEL });

  expect(expectOk(selector.select({})).model).toBe(QWEN_MODEL);
});

test("an unknown ASR_MODEL is rejected rather than passed through", () => {
  const selector = createProviderSelector({ DASHSCOPE_API_KEY: "dk", ASR_MODEL: "nope" });

  expect(expectErr(selector.select({})).code).toBe("unknown_model");
});

test("an explicit provider does not inherit the primary's model", () => {
  const selector = createProviderSelector({
    DASHSCOPE_API_KEY: "dk",
    BYTEPLUS_API_KEY: "bk",
    ASR_MODEL: QWEN_MODEL,
  });

  expect(expectOk(selector.select({ provider: "byteplus" })).model).toBe("bigmodel");
});

// --- Rejecting bad requests cleanly ---

test("an unknown provider id is rejected cleanly", () => {
  const selector = createProviderSelector({ DASHSCOPE_API_KEY: "dk" });

  const error = expectErr(selector.select({ provider: "definitely-not-real" }));

  expect(error.code).toBe("unknown_provider");
  expect(error.message).toContain("definitely-not-real");
});

test("an unknown model is rejected cleanly", () => {
  const selector = createProviderSelector({ DASHSCOPE_API_KEY: "dk" });

  expect(expectErr(selector.select({ model: "whisper-9000" })).code).toBe("unknown_model");
});

test("rejection messages fit in a websocket close reason", () => {
  const selector = createProviderSelector({ DASHSCOPE_API_KEY: "dk" });

  for (const request of [{ provider: "x".repeat(400) }, { model: "y".repeat(400) }]) {
    const error = expectErr(selector.select(request));
    expect(Buffer.byteLength(error.message, "utf8")).toBeLessThanOrEqual(123);
  }
});

// --- Enablement ---

test("a provider without credentials is not selectable", () => {
  const selector = createProviderSelector({ DASHSCOPE_API_KEY: "dk" });

  expect(expectErr(selector.select({ provider: "byteplus" })).code).toBe("not_enabled");
});

test("ASR_PROVIDERS narrows what a client may select", () => {
  const selector = createProviderSelector({
    DASHSCOPE_API_KEY: "dk",
    BYTEPLUS_API_KEY: "bk",
    ASR_PROVIDERS: "qwen",
  });

  expect(selector.enabledProviderIds).toEqual(["qwen"]);
  expect(expectErr(selector.select({ provider: "byteplus" })).code).toBe("not_enabled");
  expect(expectOk(selector.select({ provider: "qwen" })).providerId).toBe("qwen");
});

test("credentials alone make a provider selectable", () => {
  const selector = createProviderSelector({ DASHSCOPE_API_KEY: "dk", BYTEPLUS_API_KEY: "bk" });

  expect(selector.enabledProviderIds).toContain("byteplus");
});

test("the primary is always selectable, even if ASR_PROVIDERS omits it", () => {
  const selector = createProviderSelector({ DASHSCOPE_API_KEY: "dk", ASR_PROVIDERS: "mock" });

  expect(expectOk(selector.select({ provider: "qwen" })).providerId).toBe("qwen");
});

// --- Startup validation ---

test("a typo'd ASR_PROVIDER fails the boot instead of falling back to qwen", () => {
  expect(() => createProviderSelector({ ASR_PROVIDER: "qwenn", DASHSCOPE_API_KEY: "dk" })).toThrow(
    /not a known ASR provider/,
  );
});

test("a typo'd ASR_PROVIDERS entry fails the boot", () => {
  expect(() =>
    createProviderSelector({ DASHSCOPE_API_KEY: "dk", ASR_PROVIDERS: "qwen,bytplus" }),
  ).toThrow(/unknown ASR provider "bytplus"/);
});
