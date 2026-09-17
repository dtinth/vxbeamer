import WebSocket from "ws";
import type { ASRCreateSessionOptions, ASRProvider, ASRSession } from "../asr.ts";
import { BYTES_PER_SECOND } from "../audio.ts";
import { createBufferedSocketSession } from "./bufferedSocketSession.ts";

/**
 * Meta's own realtime speech-to-text endpoint — unlike every OpenRouter
 * model this package also offers (`./openrouter.ts`), this one is a genuine
 * streaming protocol with partial transcripts, not a batch upload wrapped in
 * a WebSocket-shaped API. Protocol confirmed against Meta's own docs
 * (https://dev.meta.ai/docs/api-reference/voice/realtime, dtinth/vxbeamer#86):
 *
 * - Auth travels in the handshake JSON body, not an `Authorization` header —
 *   the docs state the header is ignored for this endpoint.
 * - Audio goes over the wire as raw binary frames, no envelope, unlike every
 *   other realtime provider here which wraps each chunk in a JSON append
 *   event.
 * - The handshake ack (`{"sessionId": "..."}`) carries no `type` field, unlike
 *   every later server frame — `handleMessage` below relies on that to skip
 *   it silently (no branch matches, so it falls through).
 * - Only `PUSH_TO_TALK` mode is used: the caller decides when a turn ends, the
 *   same model every other provider here follows, so `speechStart`/
 *   `speechEnd`/`speechComplete` (ENDPOINTING-only) and `speaker`
 *   (DIARIZATION-only) never arrive and are not handled.
 */
export interface MetaMuseProviderConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

const CHUNK_SIZE = 3200; // 100ms at 16kHz 16-bit mono

export const META_MUSE_DEFAULT_MODEL = "muse-voice-transcribe-1.0";

// $0.18 per hour of audio processed, billed rounded down to whole seconds —
// Meta's own published rate, confirmed to match what OpenRouter passed
// through for the same model with no markup (dtinth/vxbeamer#86).
const META_PRICE_PER_SECOND = 0.18 / 3600;

export function createMetaMuseProvider(config: MetaMuseProviderConfig): ASRProvider {
  return {
    createSession(callbacks: ASRCreateSessionOptions): ASRSession {
      const ws = new WebSocket(config.baseUrl ?? "wss://api.meta.ai/v1/asr/realtime");

      let totalBytesSent = 0;

      return createBufferedSocketSession({
        ws,
        chunkSize: CHUNK_SIZE,
        sendChunk(chunk) {
          totalBytesSent += chunk.length;
          ws.send(chunk);
        },
        sendHandshake() {
          ws.send(
            JSON.stringify({
              authorization: { accessToken: `Bearer ${config.apiKey}` },
              audioEncoding: "PCM_16KHZ",
              model: config.model ?? META_MUSE_DEFAULT_MODEL,
              mode: "PUSH_TO_TALK",
            }),
          );
        },
        endTurn(remaining) {
          if (remaining.length > 0) {
            totalBytesSent += remaining.length;
            ws.send(remaining);
          }
          ws.send(JSON.stringify({ type: "endStream" }));
        },
        handleMessage(raw) {
          const data = JSON.parse(raw.toString());

          if (data.type === "transcript") {
            if (data.final) {
              callbacks.onFinal?.(data.transcript ?? "");
              const seconds = Math.ceil(totalBytesSent / BYTES_PER_SECOND);
              callbacks.onUsage?.([
                {
                  sku: `meta:${config.model ?? META_MUSE_DEFAULT_MODEL}:seconds`,
                  unitPrice: META_PRICE_PER_SECOND,
                  quantity: seconds,
                },
              ]);
              callbacks.onEnd?.();
              ws.close(1000, "done");
            } else {
              callbacks.onPartial?.(data.transcript ?? "");
            }
          } else if (data.type === "error") {
            callbacks.onError?.(new Error(data.message ?? JSON.stringify(data)));
            ws.close();
          }
          // The untyped handshake ack, and speechStart/speechEnd/speechComplete/
          // speaker (ENDPOINTING and DIARIZATION only — this provider always
          // requests PUSH_TO_TALK), fall through unhandled.
        },
        onError(err) {
          callbacks.onError?.(err);
        },
      });
    },
  };
}
