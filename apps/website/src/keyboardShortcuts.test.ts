import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { createStorage } from "./testStorage.ts";
import type { ShortcutKeyEvent } from "./keyboardShortcuts.ts";

// `keyboardShortcuts.ts` imports store atoms whose initializers read
// `localStorage` at module-evaluation time — stub the globals it needs, the
// same way store.test.ts does, before each dynamic import below.
beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.stubGlobal("localStorage", createStorage());
  vi.stubGlobal("window", { location: { origin: "https://example.com" } });
});

/** A stand-in for a DOM element, duck-typed the same way the real target is
 *  read — there's no real `EventTarget` to construct without a DOM. */
function fakeTarget(props: { tagName: string; isContentEditable?: boolean }): EventTarget {
  return props as unknown as EventTarget;
}

function keyEvent(overrides: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent {
  return {
    repeat: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    target: null,
    ...overrides,
  };
}

describe("isShortcutEligible", () => {
  test("a plain, unmodified first press is eligible", async () => {
    const { isShortcutEligible } = await import("./keyboardShortcuts.ts");
    expect(isShortcutEligible(keyEvent())).toBe(true);
  });

  test("a key-repeat while held is not eligible", async () => {
    // Otherwise holding `c` would copy repeatedly, and holding Space would
    // start a new push-to-talk recording on every OS auto-repeat tick.
    const { isShortcutEligible } = await import("./keyboardShortcuts.ts");
    expect(isShortcutEligible(keyEvent({ repeat: true }))).toBe(false);
  });

  test("a modified press is not eligible, so it never shadows a browser shortcut", async () => {
    const { isShortcutEligible } = await import("./keyboardShortcuts.ts");
    expect(isShortcutEligible(keyEvent({ ctrlKey: true }))).toBe(false);
    expect(isShortcutEligible(keyEvent({ altKey: true }))).toBe(false);
    expect(isShortcutEligible(keyEvent({ metaKey: true }))).toBe(false);
  });

  test("typing into a text input is not eligible", async () => {
    const { isShortcutEligible } = await import("./keyboardShortcuts.ts");
    expect(isShortcutEligible(keyEvent({ target: fakeTarget({ tagName: "INPUT" }) }))).toBe(false);
    expect(isShortcutEligible(keyEvent({ target: fakeTarget({ tagName: "TEXTAREA" }) }))).toBe(
      false,
    );
    expect(isShortcutEligible(keyEvent({ target: fakeTarget({ tagName: "SELECT" }) }))).toBe(false);
  });

  test("a contenteditable element is not eligible, regardless of its tag", async () => {
    const { isShortcutEligible } = await import("./keyboardShortcuts.ts");
    expect(
      isShortcutEligible(
        keyEvent({ target: fakeTarget({ tagName: "DIV", isContentEditable: true }) }),
      ),
    ).toBe(false);
  });

  test("a plain element, like the record button itself, is eligible", async () => {
    const { isShortcutEligible } = await import("./keyboardShortcuts.ts");
    expect(isShortcutEligible(keyEvent({ target: fakeTarget({ tagName: "BUTTON" }) }))).toBe(true);
  });
});
