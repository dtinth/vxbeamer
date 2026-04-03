import { beforeEach, expect, test, vi } from "vite-plus/test";

function encodeToken(payload: Record<string, unknown>): string {
  const base64 = btoa(JSON.stringify(payload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `header.${base64}.signature`;
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

test("stores and loads session token from localStorage", async () => {
  const { $sessionToken, saveSessionToken, clearSessionToken } = await import("./store.ts");
  const accessToken = encodeToken({ sub: "user-1", exp: Math.floor(Date.now() / 1000) + 3600 });

  saveSessionToken(accessToken, "refresh-token");
  expect($sessionToken.get()).toBe(accessToken);

  clearSessionToken();
  expect($sessionToken.get()).toBeNull();
});
