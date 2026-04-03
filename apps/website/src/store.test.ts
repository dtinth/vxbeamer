import { beforeEach, expect, test, vi } from "vite-plus/test";

function encodeToken(payload: Record<string, unknown>): string {
  const base64 = btoa(JSON.stringify(payload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `header.${base64}.signature`;
}

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.stubGlobal("localStorage", createStorage());
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

test("stores desktop swipe behavior in localStorage", async () => {
  const { $desktopSwipeBehavior, setDesktopSwipeBehavior } = await import("./store.ts");

  expect($desktopSwipeBehavior.get()).toBe("none");

  setDesktopSwipeBehavior("paste");
  expect($desktopSwipeBehavior.get()).toBe("paste");
});

test("backend URL defaults to blank", async () => {
  const { $backendUrl } = await import("./store.ts");

  expect($backendUrl.get()).toBe("");
});
