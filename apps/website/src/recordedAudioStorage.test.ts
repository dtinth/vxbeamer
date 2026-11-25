import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import {
  $retainedRecordings,
  MAX_RETAINED_BYTES_TOTAL,
  attachAudioStorage,
  clearRetainedRecordings,
  detachAudioStorage,
  getRetainedRecording,
  releaseRetainedRecording,
  retainRecording,
  setRetainedTranscript,
  type AudioStorage,
  type RetainedRecording,
} from "./recordedAudio.ts";

const MB = 1024 * 1024;

/** An {@link AudioStorage} that lives in a Map, standing in for IndexedDB. */
function createMemoryStorage(initial: RetainedRecording[] = []) {
  const records = new Map(initial.map((r) => [r.referenceId, r]));
  const storage: AudioStorage = {
    loadAll: async () => [...records.values()],
    save: async (recording) => void records.set(recording.referenceId, recording),
    remove: async (ids) => ids.forEach((id) => records.delete(id)),
    clear: async () => records.clear(),
  };
  return { storage, records };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function record(referenceId: string, bytes: number): void {
  const retainer = retainRecording(referenceId);
  retainer.append(new ArrayBuffer(bytes));
  retainer.commit();
}

function saved(referenceId: string, bytes: number, createdAt: number): RetainedRecording {
  return {
    referenceId,
    chunks: [new ArrayBuffer(bytes)],
    byteLength: bytes,
    capturedByteLength: bytes,
    droppedForSize: false,
    createdAt,
  };
}

beforeEach(() => {
  detachAudioStorage();
  $retainedRecordings.set(new Map());
});

afterEach(() => {
  detachAudioStorage();
  vi.restoreAllMocks();
});

test("a committed recording is saved", async () => {
  const { storage, records } = createMemoryStorage();
  await attachAudioStorage(storage);

  record("ref-1", 1000);
  await settle();

  expect([...records.keys()]).toEqual(["ref-1"]);
  expect(records.get("ref-1")?.byteLength).toBe(1000);
});

test("saved recordings come back after a reload", async () => {
  const { storage } = createMemoryStorage([saved("old", 500, 1), saved("older", 500, 0)]);

  await attachAudioStorage(storage);

  expect([...$retainedRecordings.get().keys()]).toEqual(["older", "old"]);
  expect(getRetainedRecording("old")?.byteLength).toBe(500);
});

test("a recording made before the saved ones finished loading is kept as well", async () => {
  const { storage } = createMemoryStorage([saved("old", 500, 1)]);

  const loading = attachAudioStorage(storage);
  record("new", 700);
  await loading;

  expect(getRetainedRecording("old")).toBeDefined();
  expect(getRetainedRecording("new")).toBeDefined();
});

test("the oldest recordings go first, from memory and from storage", async () => {
  const { storage, records } = createMemoryStorage();
  await attachAudioStorage(storage);

  record("a", 4 * MB);
  record("b", 4 * MB);
  record("c", 4 * MB); // 12 MB in all, over the 10 MB cap
  await settle();

  expect([...$retainedRecordings.get().keys()]).toEqual(["b", "c"]);
  expect([...records.keys()].sort()).toEqual(["b", "c"]);
  expect(MAX_RETAINED_BYTES_TOTAL).toBe(10 * MB);
});

test("saved recordings that no longer fit are dropped when they load", async () => {
  const { storage, records } = createMemoryStorage([saved("a", 6 * MB, 0), saved("b", 6 * MB, 1)]);

  await attachAudioStorage(storage);
  await settle();

  expect([...$retainedRecordings.get().keys()]).toEqual(["b"]);
  expect([...records.keys()]).toEqual(["b"]);
});

test("a recording that outgrew the cap leaves nothing behind", async () => {
  const { storage, records } = createMemoryStorage();
  await attachAudioStorage(storage);

  record("huge", MAX_RETAINED_BYTES_TOTAL + 1);
  await settle();

  expect(records.size).toBe(0);
});

test("releasing a recording, or clearing them all, erases it from storage", async () => {
  const { storage, records } = createMemoryStorage();
  await attachAudioStorage(storage);
  record("ref-1", 100);
  record("ref-2", 100);
  await settle();

  releaseRetainedRecording("ref-1");
  await settle();
  expect([...records.keys()]).toEqual(["ref-2"]);

  clearRetainedRecordings();
  await settle();
  expect(records.size).toBe(0);
});

test("a storage that fails never interrupts recording", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  await attachAudioStorage({
    loadAll: async () => {
      throw new Error("blocked");
    },
    save: async () => {
      throw new Error("quota");
    },
    remove: async () => undefined,
    clear: async () => undefined,
  });

  record("ref-1", 100);
  await settle();

  expect(getRetainedRecording("ref-1")).toBeDefined();
  expect(warn).toHaveBeenCalled();
});

test("a finished transcript is saved with its audio, and survives a reload", async () => {
  const first = createMemoryStorage();
  await attachAudioStorage(first.storage);
  record("r1", 100);
  await settle();

  setRetainedTranscript({
    id: "m1",
    referenceId: "r1",
    status: "done",
    final: "Good morning",
    createdAt: 1,
    updatedAt: 2,
  });
  await settle();
  expect(first.records.get("r1")?.transcript?.final).toBe("Good morning");

  // A fresh page load: nothing in memory, only what the storage holds.
  detachAudioStorage();
  $retainedRecordings.set(new Map());
  await attachAudioStorage(first.storage);
  expect(getRetainedRecording("r1")?.transcript?.final).toBe("Good morning");
});

test("a transcript with no audio here is not saved, and one already saved is not rewritten", async () => {
  const { storage } = createMemoryStorage();
  const save = vi.spyOn(storage, "save");
  await attachAudioStorage(storage);
  const message = {
    id: "m1",
    referenceId: "r1",
    status: "done" as const,
    final: "Hi",
    createdAt: 1,
    updatedAt: 2,
  };

  setRetainedTranscript(message); // from another device: no audio here
  record("r1", 100);
  await settle();
  save.mockClear();

  setRetainedTranscript(message);
  setRetainedTranscript(message); // reconnecting resends it
  await settle();

  expect(save).toHaveBeenCalledTimes(1);
});
