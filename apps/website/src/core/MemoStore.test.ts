import { atom } from "nanostores";
import { expect, test } from "vite-plus/test";
import { MemoStore, NOT_TRANSCRIBED_YET, type Message, type SavedAudio } from "./MemoStore.ts";

function createHarness() {
  const audio = atom<ReadonlyMap<string, SavedAudio>>(new Map());
  const removed: string[] = [];
  const store = new MemoStore({
    audio,
    removeAudio: (ids) => void removed.push(...ids),
  });
  const saveAudio = (referenceId: string, createdAt = 100) =>
    audio.set(new Map(audio.get()).set(referenceId, { createdAt }));
  return { store, saveAudio, removed };
}

function message(id: string, referenceId?: string, overrides: Partial<Message> = {}): Message {
  return { id, referenceId, status: "done", final: "Hi", createdAt: 1, updatedAt: 1, ...overrides };
}

test("memos from other devices are just transcripts, with no audio", () => {
  const { store } = createHarness();

  store.applyFeedEvent({ type: "snapshot", messages: [message("m1", "from-phone")] });

  expect([...store.memos.get().keys()]).toEqual(["m1"]);
});

test("feed events create, update and delete server messages", () => {
  const { store } = createHarness();

  store.applyFeedEvent({ type: "created", message: message("m1", "r1", { status: "recording" }) });
  store.applyFeedEvent({ type: "updated", message: message("m1", "r1", { final: "Done" }) });
  expect(store.memos.get().get("m1")?.final).toBe("Done");

  store.applyFeedEvent({ type: "deleted", messageId: "m1" });
  expect(store.memos.get().size).toBe(0);
});

test("with nothing local to add, the memos are the server's messages themselves", () => {
  const { store } = createHarness();

  store.applyFeedEvent({ type: "snapshot", messages: [message("m1")] });

  expect(store.memos.get()).toBe(store.messages.get());
});

test("audio with no transcript shows as not transcribed yet, once the feed has loaded", () => {
  const { store, saveAudio } = createHarness();
  saveAudio("offline", 50);

  // Before the feed has described the server, nothing can be called missing.
  expect(store.memos.get().size).toBe(0);

  store.applyFeedEvent({ type: "snapshot", messages: [] });

  expect(store.memos.get().get("local:offline")).toEqual({
    id: "local:offline",
    referenceId: "offline",
    status: "error",
    error: NOT_TRANSCRIBED_YET,
    connectionError: true,
    createdAt: 50,
    updatedAt: 50,
  });
});

test("an untranscribed memo goes away once its transcript arrives", () => {
  const { store, saveAudio } = createHarness();
  saveAudio("offline");
  store.applyFeedEvent({ type: "snapshot", messages: [] });
  expect(store.memos.get().has("local:offline")).toBe(true);

  store.applyFeedEvent({ type: "created", message: message("m1", "offline") });

  expect(store.memos.get().has("local:offline")).toBe(false);
  expect(store.memos.get().has("m1")).toBe(true);
});

test("a recording this page is still delivering is not called untranscribed", () => {
  const { store, saveAudio } = createHarness();
  store.applyFeedEvent({ type: "snapshot", messages: [] });

  store.markLive("now");
  saveAudio("now");

  expect(store.memos.get().size).toBe(0);
});

test("a connect error shows as its own memo, and survives a snapshot", () => {
  const { store } = createHarness();

  store.setConnectionError("r1", "Connection failed");
  store.applyFeedEvent({ type: "snapshot", messages: [message("m1")] });

  expect(store.memos.get().get("local:r1")).toMatchObject({
    error: "Connection failed",
    connectionError: true,
  });
  expect(store.memos.get().has("m1")).toBe(true);
});

test("a connect error keeps its first createdAt across repeated failures", () => {
  const { store } = createHarness();

  store.setConnectionError("r1", "Connection failed", 10);
  store.setConnectionError("r1", "Connection timed out", 20);

  expect(store.localConnectionErrors.get().get("r1")).toMatchObject({
    createdAt: 10,
    updatedAt: 20,
    error: "Connection timed out",
  });
});

test("a connect error is reconciled away by the real message, and shown once with audio", () => {
  const { store, saveAudio } = createHarness();
  saveAudio("r1");
  store.applyFeedEvent({ type: "snapshot", messages: [] });
  store.setConnectionError("r1", "Connection failed");

  // The error bubble stands in for the untranscribed one: one memo, not two.
  expect([...store.memos.get().keys()]).toEqual(["local:r1"]);
  expect(store.memos.get().get("local:r1")?.error).toBe("Connection failed");

  store.applyFeedEvent({ type: "created", message: message("m1", "r1") });
  expect([...store.memos.get().keys()]).toEqual(["m1"]);
});

test("clearing a connect error on a successful retry keeps the audio", () => {
  const { store, removed } = createHarness();
  store.setConnectionError("r1", "Connection failed");

  store.clearConnectionError("r1");

  expect(removed).toEqual([]);
});

test("deleting a message erases its audio", () => {
  const { store, removed } = createHarness();
  store.applyFeedEvent({ type: "created", message: message("m1", "r1") });

  store.applyFeedEvent({ type: "deleted", messageId: "m1" });

  expect(removed).toEqual(["r1"]);
});

test("a message missing from a later snapshot erases its audio; one never seen does not", () => {
  const { store, removed } = createHarness();
  store.applyFeedEvent({ type: "snapshot", messages: [message("m1", "r1")] });

  // Reconnect: m1 was deleted meanwhile. An offline recording was never in the feed.
  store.applyFeedEvent({ type: "snapshot", messages: [] });

  expect(removed).toEqual(["r1"]);
});

test("forgetting a memo erases its error and its audio", () => {
  const { store, removed } = createHarness();
  store.setConnectionError("r1", "Connection failed");
  store.markLive("r1");

  store.forget("r1");

  expect(store.memos.get().size).toBe(0);
  expect(removed).toEqual(["r1"]);
});
