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

test("signed out, pairing is the only way in", async () => {
  vi.stubGlobal("localStorage", createStorage());
  vi.stubGlobal("window", { location: { origin: "https://example.com", pathname: "/" } });

  const { SettingsSheet } = await import("./SettingsSheet.tsx");
  const markup = renderToStaticMarkup(<SettingsSheet open />);

  expect(markup).toContain("Pair with a link");
  expect(markup).toContain("Scan a QR code");
  expect(markup).not.toContain("Backend URL");
  expect(markup).not.toContain("Sign in with OIDC");
  expect(markup).not.toContain("Log in with another browser");
  expect(markup).toContain("Audio Processing");
  expect(markup).toContain(">On<");
  expect(markup).toContain(">Off<");
  expect(markup).toContain("Transcript history");
  expect(markup).toContain("Latest 10 only");
  expect(markup).toContain("Recording button");
  expect(markup).toContain("Refresh app");
  // The Pair button waits for a link to be entered.
  expect(markup).toContain("disabled");
});

test("the desktop app pairs the same way", async () => {
  vi.stubGlobal("localStorage", createStorage());
  vi.stubGlobal("window", {
    location: { origin: "https://example.com", pathname: "/" },
    __TAURI__: {},
  });

  const { SettingsSheet } = await import("./SettingsSheet.tsx");
  const markup = renderToStaticMarkup(<SettingsSheet open />);

  expect(markup).toContain("Pair with a link");
  expect(markup).not.toContain("Sign in with OIDC");
  expect(markup).toContain("disabled");
});
