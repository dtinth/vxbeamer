import WebSocket from "ws";
import type { ASRCreateSessionOptions, ASRProvider, ASRSession } from "../asr.ts";
import { BYTES_PER_SECOND } from "../audio.ts";
import { createBufferedSocketSession } from "./bufferedSocketSession.ts";
import { joinText } from "./joinText.ts";

/**
 * xAI's Grok Voice Transcribe, over its streaming speech-to-text WebSocket
 * (`wss://api.x.ai/v1/stt`).
 *
 * The wire, as confirmed live (testdata/OBSERVATIONS.md, "Grok Voice Transcribe"):
 *
 * - Everything is configured in the URL's query string; there is no setup message.
 * - The server sends `transcript.created`; audio may only be sent after it, so
 *   chunks are held until then and `audio.done` waits behind them.
 * - Audio is raw binary PCM frames. The turn ends with `{"type":"audio.done"}`.
 * - `transcript.partial` carries `is_final` and `speech_final`: an interim
 *   (`false`/`false`) is the running text of the chunk being heard; a chunk final
 *   (`true`/`false`) locks about 3 s of it; an utterance final (`true`/`true`)
 *   carries the whole stitched utterance, and is sent after a silence or at the
 *   end of the audio.
 * - **`transcript.done.text` is empty.** The text is in the utterance finals, so
 *   that is what the final transcript is built from.
 *
 * Billed per second of audio. The vendor's streaming rate is $0.20 per hour.
 */

/** USD per second: $0.20 per hour of audio, streaming (xAI's announcement, 2026-09-18). */
export const XAI_PRICE_PER_SECOND = 0.2 / 3600;

export const XAI_DEFAULT_MODEL = "grok-voice-transcribe-2.0";

/** 100 ms of 16 kHz 16-bit mono, the vendor's own recommendation. */
const CHUNK_SIZE = 3200;

const DEFAULT_BASE_URL = "wss://api.x.ai/v1/stt";

export interface XaiProviderConfig {
  apiKey: string;
  model?: string;
  /** Endpoint, without the query string. Overridden in tests. */
  baseUrl?: string;
  /** USD per second of audio. Overrides {@link XAI_PRICE_PER_SECOND}. */
  pricePerSecond?: number;
  /**
   * The vendor's `language` parameter. Default `"en"`; `null` leaves the
   * language to auto-detection.
   *
   * It is set because the vendor's text formatting (`format`, below) is refused
   * without one, and Thai is not among the languages formatting covers
   * (`language=th&format=true` changed nothing in testing). On the Thai fixture
   * `en` left the Thai and the Latin words intact, but Thai *spoken numbers*
   * under an English bias have not been tried: no Thai audio with numbers was
   * available.
   */
  language?: string | null;
  /**
   * The vendor's text formatting: spoken numbers, currencies and phone numbers
   * written out as digits. Default **true**; it only takes effect together with
   * a supported {@link language}, and is not sent without one.
   */
  format?: boolean;
}

interface ServerEvent {
  type?: string;
  text?: string;
  duration?: number;
  message?: string;
  is_final?: boolean;
  speech_final?: boolean;
}

export function createXaiProvider(config: XaiProviderConfig): ASRProvider {
  const model = config.model ?? XAI_DEFAULT_MODEL;
  const pricePerSecond = config.pricePerSecond ?? XAI_PRICE_PER_SECOND;
  const query = new URLSearchParams({
    model,
    sample_rate: "16000",
    encoding: "pcm",
    // Partials arrive about a second in. The end-of-audio wait is erratic with
    // or without them (0.3 s to 40 s across single sessions, either way), so
    // that is the vendor, not this setting: without them the first text only
    // comes after ~5 s.
    interim_results: "true",
  });
  const language = config.language === undefined ? "en" : config.language;
  if (language) {
    query.set("language", language);
    // The vendor refuses `format` without a language.
    if (config.format ?? true) query.set("format", "true");
  }
  const url = `${config.baseUrl ?? DEFAULT_BASE_URL}?${query}`;

  return {
    createSession(callbacks: ASRCreateSessionOptions): ASRSession {
      const ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
      });

      let created = false;
      let endRequested = false;
      let held: Buffer[] = [];
      let totalBytesSent = 0;
      // Finished utterances, in order.
      let utterances = "";
      // The utterance being spoken: chunks the vendor has locked, then the
      // running text of the chunk after them.
      let lockedChunks = "";
      let interim = "";
      let done = false;

      const sendAudio = (audio: Buffer) => {
        totalBytesSent += audio.length;
        ws.send(audio);
      };
      const sendDone = () => ws.send(JSON.stringify({ type: "audio.done" }));

      const current = () => joinText(lockedChunks, interim);
      const transcript = () => joinText(utterances, current());

      function fail(error: Error) {
        if (done) return;
        done = true;
        callbacks.onError?.(error);
        ws.close();
      }

      let abandoned = false;
      const session = createBufferedSocketSession({
        ws,
        chunkSize: CHUNK_SIZE,
        sendHandshake() {},
        sendChunk(chunk) {
          if (created) sendAudio(chunk);
          else held.push(Buffer.from(chunk));
        },
        endTurn(remaining) {
          if (remaining.length > 0) {
            if (created) sendAudio(remaining);
            else held.push(Buffer.from(remaining));
          }
          endRequested = true;
          if (created) sendDone();
        },
        handleMessage(raw) {
          let event: ServerEvent;
          try {
            event = JSON.parse(raw.toString("utf8"));
          } catch {
            return;
          }
          if (done) return;
          switch (event.type) {
            case "transcript.created": {
              if (created) return;
              created = true;
              for (const chunk of held) sendAudio(chunk);
              held = [];
              if (endRequested) sendDone();
              return;
            }
            case "transcript.partial": {
              const text = event.text ?? "";
              if (event.speech_final) {
                // The whole utterance, stitched: it replaces what was built up.
                utterances = joinText(utterances, text);
                lockedChunks = "";
                interim = "";
              } else if (event.is_final) {
                lockedChunks = joinText(lockedChunks, text);
                interim = "";
              } else {
                interim = text;
              }
              const running = transcript();
              if (running) callbacks.onPartial?.(running);
              return;
            }
            case "transcript.done": {
              done = true;
              // `done.text` is empty; if the audio ended without an utterance
              // final, what was heard so far is still the answer.
              const text = transcript();
              if (text.trim()) callbacks.onFinal?.(text);
              const seconds = event.duration ?? totalBytesSent / BYTES_PER_SECOND;
              callbacks.onUsage?.([
                { sku: `xai:${model}:seconds`, unitPrice: pricePerSecond, quantity: seconds },
              ]);
              callbacks.onEnd?.();
              ws.close(1000, "done");
              return;
            }
            case "error": {
              fail(new Error(`xAI STT error: ${event.message ?? JSON.stringify(event)}`));
              return;
            }
          }
        },
        onError(err) {
          fail(err);
        },
      });

      // The vendor can drop the socket without `transcript.done` (an idle
      // timeout, a restart). Without this the session would wait for an end that
      // is not coming.
      ws.on("close", () => {
        if (!abandoned) fail(new Error("xAI STT connection closed before the transcript was done"));
      });

      return {
        ...session,
        close() {
          // The caller hanging up is not a failure.
          abandoned = true;
          session.close();
        },
      };
    },
  };
}
