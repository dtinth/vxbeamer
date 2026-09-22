import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { createStorage } from "./testStorage.ts";
import type { Message } from "./store.ts";

/**
 * The rule these exist for: auto-copy must only ever take the clipboard for
 * a recording made *here*. The feed carries every signed-in device's
 * messages, so "the transcript that just finished" is not the same thing as
 * "the transcript I just recorded" (dtinth/vxbeamer#86).
 */

const MINE = "reference-mine";
const THEIRS = "reference-theirs";

/** Bubble clicks the module asked for, in order. */
let clicked: string[] = [];

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.stubGlobal("localStorage", createStorage());
  vi.stubGlobal("window", { location: { origin: "https://example.com" } });

  clicked = [];
  // The module finds a bubble by `data-message-id` and clicks it — there is
  // no DOM here, so this stands in for one the same way the other tests
  // duck-type their elements.
  vi.stubGlobal("document", {
    querySelector(selector: string) {
      const match = /\[data-message-id="([^"]+)"\]/.exec(selector);
      if (!match) return null;
      return { click: () => clicked.push(match[1]!) };
    },
  });
});

async function load() {
  const store = await import("./store.ts");
  const autoCopy = await import("./autoCopy.ts");
  return { ...store, ...autoCopy };
}

function message(overrides: Partial<Message> & { id: string }): Message {
  return { status: "done", createdAt: 1, updatedAt: 1, ...overrides } as Message;
}

describe("auto copy", () => {
  test("copies this client's transcript once it finishes", async () => {
    const m = await load();
    m.setAutoCopy(true);
    const detach = m.attachAutoCopy();

    m.$activeRecordingReferenceId.set(MINE);
    m.$activeRecordingReferenceId.set(null); // stop pressed
    m.$messages.set(new Map([["m1", message({ id: "m1", referenceId: MINE, final: "hello" })]]));
    await vi.waitFor(() => expect(clicked).toEqual(["m1"]));

    detach();
  });

  test("ignores a transcript from another client", async () => {
    // The whole point: another device finishing must never take this
    // device's clipboard.
    const m = await load();
    m.setAutoCopy(true);
    const detach = m.attachAutoCopy();

    m.$activeRecordingReferenceId.set(MINE);
    m.$activeRecordingReferenceId.set(null);
    m.$messages.set(
      new Map([["other", message({ id: "other", referenceId: THEIRS, final: "not mine" })]]),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(clicked).toEqual([]);
    detach();
  });

  test("still copies mine when another client's arrives first", async () => {
    const m = await load();
    m.setAutoCopy(true);
    const detach = m.attachAutoCopy();

    m.$activeRecordingReferenceId.set(MINE);
    m.$activeRecordingReferenceId.set(null);
    m.$messages.set(
      new Map([["other", message({ id: "other", referenceId: THEIRS, final: "not mine" })]]),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(clicked).toEqual([]);

    m.$messages.set(
      new Map([
        ["other", message({ id: "other", referenceId: THEIRS, final: "not mine" })],
        ["m1", message({ id: "m1", referenceId: MINE, final: "mine" })],
      ]),
    );
    await vi.waitFor(() => expect(clicked).toEqual(["m1"]));

    detach();
  });

  test("does nothing while the setting is off", async () => {
    const m = await load();
    const detach = m.attachAutoCopy();

    m.$activeRecordingReferenceId.set(MINE);
    m.$activeRecordingReferenceId.set(null);
    m.$messages.set(new Map([["m1", message({ id: "m1", referenceId: MINE, final: "hello" })]]));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(clicked).toEqual([]);
    detach();
  });

  test("reads the setting when the recording stops, not when the transcript lands", async () => {
    // Turning it off later must not cancel a copy already committed to.
    const m = await load();
    m.setAutoCopy(true);
    const detach = m.attachAutoCopy();

    m.$activeRecordingReferenceId.set(MINE);
    m.$activeRecordingReferenceId.set(null);
    m.setAutoCopy(false);
    m.$messages.set(new Map([["m1", message({ id: "m1", referenceId: MINE, final: "hello" })]]));
    await vi.waitFor(() => expect(clicked).toEqual(["m1"]));

    detach();
  });

  test("waits rather than copying a recording that is still going", async () => {
    const m = await load();
    m.setAutoCopy(true);
    const detach = m.attachAutoCopy();

    m.$activeRecordingReferenceId.set(MINE);
    m.$activeRecordingReferenceId.set(null);
    m.$messages.set(
      new Map([
        ["m1", message({ id: "m1", referenceId: MINE, status: "recording", partial: "hel" })],
      ]),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(clicked).toEqual([]);

    m.$messages.set(new Map([["m1", message({ id: "m1", referenceId: MINE, final: "hello" })]]));
    await vi.waitFor(() => expect(clicked).toEqual(["m1"]));

    detach();
  });

  test("copies once, however many callers asked", async () => {
    // Push-to-talk copies on release regardless of the setting, so with the
    // setting also on, both paths ask for the same recording.
    const m = await load();
    m.setAutoCopy(true);
    const detach = m.attachAutoCopy();

    m.$activeRecordingReferenceId.set(MINE);
    m.$activeRecordingReferenceId.set(null);
    m.copyWhenFinalized(MINE); // what push-to-talk does
    m.$messages.set(new Map([["m1", message({ id: "m1", referenceId: MINE, final: "hello" })]]));
    await vi.waitFor(() => expect(clicked).toEqual(["m1"]));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(clicked).toEqual(["m1"]);
    detach();
  });

  test("push-to-talk still copies on release with the setting off", async () => {
    const m = await load();
    const detach = m.attachAutoCopy();

    m.copyWhenFinalized(MINE);
    m.$messages.set(new Map([["m1", message({ id: "m1", referenceId: MINE, final: "hello" })]]));
    await vi.waitFor(() => expect(clicked).toEqual(["m1"]));

    detach();
  });

  test("stops waiting once detached", async () => {
    const m = await load();
    m.setAutoCopy(true);
    const detach = m.attachAutoCopy();

    m.$activeRecordingReferenceId.set(MINE);
    m.$activeRecordingReferenceId.set(null);
    detach();
    m.$messages.set(new Map([["m1", message({ id: "m1", referenceId: MINE, final: "hello" })]]));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(clicked).toEqual([]);
  });
});
