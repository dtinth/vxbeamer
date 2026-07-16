import { atom } from "nanostores";
import { BITS_PER_SAMPLE, BYTES_PER_SECOND, CHANNELS, SAMPLE_RATE } from "vxasr/audio";

/**
 * In-memory retention of the PCM captured for a recording, keyed by the
 * recording's reference id (the same id carried on `Message.referenceId`), so a
 * finished recording can later be replayed against additional ASR models.
 *
 * Privacy: retained audio lives **only** in this tab's memory. It is never
 * persisted (no disk / localStorage / IndexedDB) and never uploaded from here.
 * Anything that wants to send it must ask the user first.
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
 * PROVISIONAL SIZE CAP — not a settled policy.
 *
 * The eval map (dtinth/vxbeamer#29) lists "audio size-cap policy" as explicitly
 * unspecified. These numbers are a safe placeholder so retention cannot grow
 * without bound; they are expected to be replaced once the policy is decided.
 *
 * Per recording: 10 minutes of PCM (10 x 60 x 32000 bytes). A recording that
 * runs past this stops being retained entirely rather than keeping a truncated
 * head, because a partial replay would be judged against a different utterance
 * than the primary transcript heard.
 */
export const MAX_RETAINED_BYTES_PER_RECORDING = 10 * 60 * RETAINED_AUDIO_FORMAT.bytesPerSecond;

/**
 * PROVISIONAL SIZE CAP — not a settled policy. See above.
 *
 * Across all retained recordings: ~32 minutes of PCM. Once exceeded, the oldest
 * retained recordings are released until the total fits again.
 */
export const MAX_RETAINED_BYTES_TOTAL = 32 * 60 * RETAINED_AUDIO_FORMAT.bytesPerSecond;

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
}

/**
 * Completed recordings only. A recording in progress is held by its
 * `RecordingRetainer` and appears here on `commit()`.
 */
export const $retainedRecordings = atom<Map<string, RetainedRecording>>(new Map());

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
}

/** Release every retained recording — e.g. when the session ends. */
export function clearRetainedRecordings(): void {
  if ($retainedRecordings.get().size === 0) return;
  $retainedRecordings.set(new Map());
}

/** Evicts oldest-first until the total fits under the provisional cap. */
function evictUntilUnderTotalCap(recordings: Map<string, RetainedRecording>): void {
  let total = 0;
  for (const recording of recordings.values()) total += recording.byteLength;
  // Insertion order is start order, so this drops the oldest recordings first.
  // A single recording can never exceed the per-recording cap, which is below
  // the total cap, so the recording just committed always survives.
  for (const [referenceId, recording] of recordings) {
    if (total <= MAX_RETAINED_BYTES_TOTAL) break;
    recordings.delete(referenceId);
    total -= recording.byteLength;
  }
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
      next.set(referenceId, {
        referenceId,
        chunks,
        byteLength,
        capturedByteLength,
        droppedForSize,
        createdAt,
      });
      chunks = [];
      evictUntilUnderTotalCap(next);
      $retainedRecordings.set(next);
    },
    discard() {
      if (settled) return;
      settled = true;
      chunks = [];
      byteLength = 0;
    },
  };
}
