import type { ASRCreateSessionOptions, ASRSession, UsageRecord } from "../asr.ts";
import { writeWav } from "../audio.ts";

/**
 * The buffering adapter (dtinth/vxbeamer#65): what lets a vendor that only
 * offers a *batch* API — one complete file in, one transcript out — sit behind
 * the unchanged streaming {@link ASRSession} interface.
 *
 * The frontend always streams audio over the WebSocket, whatever the
 * configuration. A batch session simply holds that audio in memory until
 * `finish()`, then makes one call with the whole clip as a WAV. So `onPartial`
 * never fires, and pacing `sendAudio` (realtime vs. a fast dump) changes
 * nothing, since nothing goes over the wire until the clip is complete.
 *
 * OpenRouter and Paxa each carried their own copy of this before it lived
 * here. What stays with each provider is exactly what is per-vendor: the
 * request, and how its response maps to a transcript and usage.
 */
export interface BatchTranscription {
  text: string;
  /** What to bill. Empty means nothing is billed, and `onUsage` is not called. */
  usage: UsageRecord[];
}

/**
 * Send one complete clip to the vendor. Throw on any failure — it is reported
 * through `onError`, unless the session was closed meanwhile. `signal` aborts
 * when the session is closed.
 */
export type BatchTranscribe = (wav: Uint8Array, signal: AbortSignal) => Promise<BatchTranscription>;

export function createBatchSession(
  options: ASRCreateSessionOptions,
  transcribe: BatchTranscribe,
): ASRSession {
  const chunks: Buffer[] = [];
  let finishing = false;
  let closed = false;
  const controller = new AbortController();

  return {
    sendAudio(chunk: Buffer) {
      if (finishing || closed) return;
      chunks.push(chunk);
    },

    finish() {
      if (finishing || closed) return;
      finishing = true;
      const pcm = Buffer.concat(chunks);
      chunks.length = 0;

      void (async () => {
        let result: BatchTranscription;
        try {
          result = await transcribe(writeWav(pcm), controller.signal);
        } catch (err) {
          if (closed) return; // close() aborted the in-flight request
          options.onError?.(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        if (closed) return;

        options.onFinal?.(result.text);
        if (result.usage.length > 0) options.onUsage?.(result.usage);
        options.onEnd?.();
      })();
    },

    close() {
      if (closed) return;
      closed = true;
      controller.abort();
    },
  };
}
