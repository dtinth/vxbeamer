import { beforeEach, expect, test, vi } from "vite-plus/test";

function encodeToken(payload: Record<string, unknown>): string {
  const base64 = btoa(JSON.stringify(payload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `${base64}.signature`;
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  });
  vi.stubGlobal("window", { location: { origin: "https://example.com" } });
});

test("refreshes one hour after iat when available", async () => {
  const { getTokenRefreshDelayMs } = await import("./store.ts");
  const token = encodeToken({ sub: "user-1", iat: 1_000, exp: 10_000 });

  expect(getTokenRefreshDelayMs(token, 1_000)).toBe(3_600_000);
  expect(getTokenRefreshDelayMs(token, 4_700)).toBe(0);
});

test("falls back to the legacy exp-based schedule when iat is missing", async () => {
  const { getTokenRefreshDelayMs } = await import("./store.ts");
  const token = encodeToken({ sub: "user-1", exp: 10_000 });

  expect(getTokenRefreshDelayMs(token, 1_000)).toBe(5_400_000);
});

test("returns null for malformed tokens", async () => {
  const { getTokenRefreshDelayMs } = await import("./store.ts");
  expect(getTokenRefreshDelayMs("not-a-token")).toBeNull();
});
