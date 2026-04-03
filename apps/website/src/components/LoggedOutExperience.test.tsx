import { beforeEach, expect, test, vi } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";

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

test("message feed asks signed-out users to open settings", async () => {
  const [{ MessageFeed }, { $messages, $sessionToken }] = await Promise.all([
    import("./MessageFeed.tsx"),
    import("../store.ts"),
  ]);
  $messages.set(new Map());
  $sessionToken.set(null);

  const markup = renderToStaticMarkup(<MessageFeed onOpenSettings={() => undefined} />);

  expect(markup).toContain("No messages yet. Sign in first to start speaking.");
  expect(markup).toContain("Open Settings");
});

test("recording bar shows a settings action while signed out", async () => {
  const [{ RecordingBar }, { $sessionToken }] = await Promise.all([
    import("./RecordingBar.tsx"),
    import("../store.ts"),
  ]);
  $sessionToken.set(null);

  const markup = renderToStaticMarkup(<RecordingBar onOpenSettings={() => undefined} />);

  expect(markup).toContain('aria-label="Open settings"');
});
