import { beforeEach, expect, test } from "vite-plus/test";
import {
  $retainedRecordings,
  MAX_RETAINED_BYTES_PER_RECORDING,
  MAX_RETAINED_BYTES_TOTAL,
  RETAINED_AUDIO_FORMAT,
  clearRetainedRecordings,
  getRetainedRecording,
  releaseRetainedRecording,
  retainRecording,
  retainedBytesTotal,
  retainedDurationSeconds,
} from "./recordedAudio.ts";

/** A PCM chunk of `byteLength` bytes, filled with `fill` so it is identifiable. */
function chunk(byteLength: number, fill = 0): ArrayBuffer {
  const buffer = new ArrayBuffer(byteLength);
  new Uint8Array(buffer).fill(fill);
  return buffer;
}

beforeEach(() => {
  clearRetainedRecordings();
});

test("retains every chunk of a recording, keyed by reference id", () => {
  const retainer = retainRecording("ref-1");
  retainer.append(chunk(4, 1));
  retainer.append(chunk(6, 2));
  retainer.commit();

  const recording = getRetainedRecording("ref-1");
  expect(recording?.referenceId).toBe("ref-1");
  expect(recording?.chunks.map((c) => c.byteLength)).toEqual([4, 6]);
  expect(recording?.byteLength).toBe(10);
  expect(recording?.capturedByteLength).toBe(10);
  expect(recording?.droppedForSize).toBe(false);
  expect(new Uint8Array(recording!.chunks[0]!)).toEqual(new Uint8Array([1, 1, 1, 1]));
});

test("does not publish a recording that is still in progress", () => {
  const retainer = retainRecording("ref-1");
  retainer.append(chunk(4));

  expect(getRetainedRecording("ref-1")).toBeUndefined();

  retainer.commit();
  expect(getRetainedRecording("ref-1")).toBeDefined();
});

test("discarding a recording retains nothing", () => {
  const retainer = retainRecording("ref-1");
  retainer.append(chunk(4));
  retainer.discard();

  expect(getRetainedRecording("ref-1")).toBeUndefined();
  expect(retainedBytesTotal()).toBe(0);
});

test("ignores chunks that arrive after the recording is settled", () => {
  const retainer = retainRecording("ref-1");
  retainer.append(chunk(4));
  retainer.commit();
  retainer.append(chunk(4));

  expect(getRetainedRecording("ref-1")?.byteLength).toBe(4);
});

test("reports duration from the captured byte count", () => {
  const retainer = retainRecording("ref-1");
  retainer.append(chunk(RETAINED_AUDIO_FORMAT.bytesPerSecond * 3));
  retainer.commit();

  expect(retainedDurationSeconds(getRetainedRecording("ref-1")!)).toBe(3);
});

test("stops retaining a recording that outgrows the per-recording cap", () => {
  const half = MAX_RETAINED_BYTES_PER_RECORDING / 2;
  const retainer = retainRecording("ref-1");
  retainer.append(chunk(half));
  retainer.append(chunk(half));
  // This chunk pushes it over the cap, so the whole recording is let go.
  retainer.append(chunk(1000));
  retainer.append(chunk(1000));
  retainer.commit();

  const recording = getRetainedRecording("ref-1");
  expect(recording?.droppedForSize).toBe(true);
  expect(recording?.chunks).toEqual([]);
  expect(recording?.byteLength).toBe(0);
  // The duration of what was said is still known, even though the audio is gone.
  expect(recording?.capturedByteLength).toBe(MAX_RETAINED_BYTES_PER_RECORDING + 2000);
  expect(retainedBytesTotal()).toBe(0);
});

test("evicts the oldest recordings once the total cap is exceeded", () => {
  const size = MAX_RETAINED_BYTES_PER_RECORDING;
  const count = Math.floor(MAX_RETAINED_BYTES_TOTAL / size) + 1;
  expect(count * size).toBeGreaterThan(MAX_RETAINED_BYTES_TOTAL);

  for (let i = 0; i < count; i++) {
    const retainer = retainRecording(`ref-${i}`);
    retainer.append(chunk(size));
    retainer.commit();
  }

  // The oldest goes first; the recording just committed always survives.
  expect(getRetainedRecording("ref-0")).toBeUndefined();
  expect(getRetainedRecording(`ref-${count - 1}`)).toBeDefined();
  expect(retainedBytesTotal()).toBeLessThanOrEqual(MAX_RETAINED_BYTES_TOTAL);
});

test("releases a single recording and clears them all", () => {
  for (const referenceId of ["ref-1", "ref-2"]) {
    const retainer = retainRecording(referenceId);
    retainer.append(chunk(4));
    retainer.commit();
  }

  releaseRetainedRecording("ref-1");
  expect(getRetainedRecording("ref-1")).toBeUndefined();
  expect(getRetainedRecording("ref-2")).toBeDefined();

  clearRetainedRecordings();
  expect($retainedRecordings.get().size).toBe(0);
});
