import { beforeEach, expect, test, vi } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";

function createStorage(entries: Record<string, string> = {}) {
  const values = new Map<string, string>(Object.entries(entries));
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
});

test("web sign-in actions are disabled until the backend URL is filled", async () => {
  vi.stubGlobal("localStorage", createStorage());
  vi.stubGlobal("window", { location: { origin: "https://example.com", pathname: "/" } });

  const { SettingsSheet } = await import("./SettingsSheet.tsx");
  const markup = renderToStaticMarkup(<SettingsSheet open />);

  expect(markup).toContain('placeholder="https://your-backend.example.com"');
  expect(markup).toContain("Sign in with OIDC");
  expect(markup).toContain("Log in with another browser");
  expect(markup).toContain("disabled");
});

test("desktop sign-in action is disabled until the backend URL is filled", async () => {
  vi.stubGlobal("localStorage", createStorage());
  vi.stubGlobal("window", {
    location: { origin: "https://example.com", pathname: "/" },
    __TAURI__: {},
  });

  const { SettingsSheet } = await import("./SettingsSheet.tsx");
  const markup = renderToStaticMarkup(<SettingsSheet open />);

  expect(markup).toContain("Sign in with OIDC");
  expect(markup).toContain("disabled");
});
