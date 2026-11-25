import { atom } from "nanostores";
import { BITS_PER_SAMPLE, BYTES_PER_SECOND, CHANNELS, SAMPLE_RATE } from "vxasr/audio";
import type { Message } from "./core/MemoStore.ts";

/**
 * In-memory retention of the PCM captured for a recording, keyed by the
 * recording's reference id (the same id carried on `Message.referenceId`), so a
 * finished recording can later be replayed against additional ASR models.
 *
 * Privacy: retained audio stays on this device. It is held in memory and,
 * through an {@link AudioStorage} (IndexedDB in the browser), saved so it
 * survives a reload; it is erased with the message it belongs to and when the
 * session ends. It is never uploaded from here. Anything that wants to send it
 * must ask the user first.
 */

/**
 * The wire format every retained chunk is in — see `createMicrophoneSource`.
 *
 * Re-exported from `vxasr/audio` rather than restated: that module owns the
 * format, and its WAV writer has to agree with the reader that accepts the
 * output. A second copy of these numbers here would be free to drift from the
 * ones the encoder actually writes.
 */
export const RETAINED_AUDIO_FORMAT = {
  sampleRate: SAMPLE_RATE,
  bitsPerSample: BITS_PER_SAMPLE,
  channels: CHANNELS,
  /** Handy for turning byte counts into seconds. */
  bytesPerSecond: BYTES_PER_SECOND,
} as const;

/**
 * Across all retained recordings: 10 MB (about 5 minutes of PCM), the same cap
 * as the Android app's audio store (`RetentionPolicy.MAX_AUDIO_BYTES`). Once
 * exceeded, the oldest retained recordings are released until the total fits
 * again (dtinth/vxbeamer#134 discussion: oldest first).
 */
export const MAX_RETAINED_BYTES_TOTAL = 10 * 1024 * 1024;

/**
 * Per recording: the whole budget. A recording that runs past this stops being
 * retained entirely rather than keeping a truncated head, because a partial
 * replay would be judged against a different utterance than the primary
 * transcript heard.
 */
export const MAX_RETAINED_BYTES_PER_RECORDING = MAX_RETAINED_BYTES_TOTAL;

/** A finished recording's PCM, held in memory and ready to be replayed. */
export interface RetainedRecording {
  /** Matches `Message.referenceId` of the message this audio produced. */
  referenceId: string;
  /** Captured PCM in order. Empty when `droppedForSize` is true. */
  chunks: readonly ArrayBuffer[];
  /** Bytes actually retained across `chunks`. */
  byteLength: number;
  /** Bytes captured in total, including any not retained because of the cap. */
  capturedByteLength: number;
  /** True when the recording outgrew the per-recording cap and was let go. */
  droppedForSize: boolean;
  /** When the recording started (epoch ms). Also the eviction order. */
  createdAt: number;
  /**
   * The last finished transcript the server gave for this recording. The server
   * only remembers messages for so long; this lets the memo outlive its copy,
   * for as long as the audio is kept.
   */
  transcript?: Message;
}

/**
 * Where retained recordings are kept between page loads. An adapter: the
 * browser's is IndexedDB (`idbAudioStorage.ts`), tests pass an in-memory one.
 * Everything here is best effort: a failing store never interrupts recording.
 */
export interface AudioStorage {
  loadAll(): Promise<RetainedRecording[]>;
  save(recording: RetainedRecording): Promise<void>;
  remove(referenceIds: readonly string[]): Promise<void>;
  clear(): Promise<void>;
}

let storage: AudioStorage | null = null;

function persist(work: (storage: AudioStorage) => Promise<void>): void {
  if (!storage) return;
  work(storage).catch((err: unknown) => {
    console.warn("Could not update the saved recordings", err);
  });
}

/**
 * Completed recordings only. A recording in progress is held by its
 * `RecordingRetainer` and appears here on `commit()`.
 */
export const $retainedRecordings = atom<Map<string, RetainedRecording>>(new Map());

/**
 * Start saving retained recordings to `audioStorage`, and bring back the ones
 * it already holds. Recordings made since startup win over saved ones with the
 * same id. Resolves once the saved ones are loaded; it never rejects.
 */
export async function attachAudioStorage(audioStorage: AudioStorage): Promise<void> {
  storage = audioStorage;
  let saved: RetainedRecording[];
  try {
    saved = await audioStorage.loadAll();
  } catch (err) {
    console.warn("Could not load the saved recordings", err);
    return;
  }
  if (storage !== audioStorage) return;

  const merged = new Map<string, RetainedRecording>();
  const all = [...saved, ...$retainedRecordings.get().values()].sort(
    (a, b) => a.createdAt - b.createdAt,
  );
  for (const recording of all) merged.set(recording.referenceId, recording);
  const evicted = evictUntilUnderTotalCap(merged);
  $retainedRecordings.set(merged);
  if (evicted.length > 0) persist((s) => s.remove(evicted));
}

/** Stop saving, and forget the storage. For tests. */
export function detachAudioStorage(): void {
  storage = null;
}

/** Accumulates a single in-progress recording's PCM. */
export interface RecordingRetainer {
  /**
   * Retain one PCM chunk. Takes ownership of `chunk` without copying, so the
   * caller must not mutate or transfer it afterwards (passing it to
   * `WebSocket.send`, which copies, is fine).
   */
  append(chunk: ArrayBuffer): void;
  /** Publish the recording to {@link $retainedRecordings}. */
  commit(): void;
  /** Release the accumulated PCM without publishing it. */
  discard(): void;
}

/** Duration in seconds of the PCM captured for a recording. */
export function retainedDurationSeconds(recording: RetainedRecording): number {
  return recording.capturedByteLength / RETAINED_AUDIO_FORMAT.bytesPerSecond;
}

/**
 * Flattens retained chunks into one contiguous PCM buffer — what both a WAV
 * body and an eval replay's frame re-cutting start from. Pass `byteLength` when
 * it is already known (a `RetainedRecording` carries it); otherwise it is summed
 * from the chunks.
 */
export function concatChunks(chunks: readonly ArrayBuffer[], byteLength?: number): Uint8Array {
  const total = byteLength ?? chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const pcm = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    pcm.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }
  return pcm;
}

/** Total bytes currently held across all retained recordings. */
export function retainedBytesTotal(): number {
  let total = 0;
  for (const recording of $retainedRecordings.get().values()) total += recording.byteLength;
  return total;
}

export function getRetainedRecording(referenceId: string): RetainedRecording | undefined {
  return $retainedRecordings.get().get(referenceId);
}

export function releaseRetainedRecording(referenceId: string): void {
  const recordings = $retainedRecordings.get();
  if (!recordings.has(referenceId)) return;
  const next = new Map(recordings);
  next.delete(referenceId);
  $retainedRecordings.set(next);
  persist((s) => s.remove([referenceId]));
}

/**
 * Keep the server's finished transcript with the recording it came from. Does
 * nothing when the audio is not here (a memo from another device) or already
 * holds this version, so reconnecting does not rewrite every saved recording.
 */
export function setRetainedTranscript(message: Message): void {
  if (!message.referenceId) return;
  const recordings = $retainedRecordings.get();
  const recording = recordings.get(message.referenceId);
  if (!recording || recording.transcript?.updatedAt === message.updatedAt) return;
  const updated = { ...recording, transcript: message };
  $retainedRecordings.set(new Map(recordings).set(recording.referenceId, updated));
  persist((s) => s.save(updated));
}

/** Release every retained recording — e.g. when the session ends. */
export function clearRetainedRecordings(): void {
  persist((s) => s.clear());
  if ($retainedRecordings.get().size === 0) return;
  $retainedRecordings.set(new Map());
}

/** Evicts oldest-first until the total fits under the cap. Returns the evicted ids. */
function evictUntilUnderTotalCap(recordings: Map<string, RetainedRecording>): string[] {
  let total = 0;
  for (const recording of recordings.values()) total += recording.byteLength;
  const evicted: string[] = [];
  // Insertion order is start order, so this drops the oldest recordings first.
  // A single recording can never exceed the per-recording cap, which equals
  // the total cap, so the recording just committed always survives.
  for (const [referenceId, recording] of recordings) {
    if (total <= MAX_RETAINED_BYTES_TOTAL) break;
    recordings.delete(referenceId);
    evicted.push(referenceId);
    total -= recording.byteLength;
  }
  return evicted;
}

/**
 * Begin retaining the PCM of a recording. The audio is held by the returned
 * retainer until `commit()` publishes it or `discard()` drops it.
 */
export function retainRecording(referenceId: string): RecordingRetainer {
  let chunks: ArrayBuffer[] = [];
  let byteLength = 0;
  let capturedByteLength = 0;
  let droppedForSize = false;
  let settled = false;
  const createdAt = Date.now();

  return {
    append(chunk) {
      if (settled) return;
      capturedByteLength += chunk.byteLength;
      if (droppedForSize) return;
      if (byteLength + chunk.byteLength > MAX_RETAINED_BYTES_PER_RECORDING) {
        // Over the cap: let the whole recording go and stop growing.
        droppedForSize = true;
        chunks = [];
        byteLength = 0;
        return;
      }
      chunks.push(chunk);
      byteLength += chunk.byteLength;
    },
    commit() {
      if (settled) return;
      settled = true;
      const next = new Map($retainedRecordings.get());
      const recording: RetainedRecording = {
        referenceId,
        chunks,
        byteLength,
        capturedByteLength,
        droppedForSize,
        createdAt,
      };
      next.set(referenceId, recording);
      chunks = [];
      const evicted = evictUntilUnderTotalCap(next);
      $retainedRecordings.set(next);
      // A recording that outgrew the cap has no audio left worth saving.
      persist(async (s) => {
        if (!droppedForSize && next.has(referenceId)) await s.save(recording);
        if (evicted.length > 0) await s.remove(evicted);
      });
    },
    discard() {
      if (settled) return;
      settled = true;
      chunks = [];
      byteLength = 0;
    },
  };
}
