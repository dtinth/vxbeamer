import WebSocket from "ws";
import type { ASRCreateSessionOptions, ASRProvider, ASRSession } from "../asr.ts";
import { BYTES_PER_SECOND } from "../audio.ts";
import { createBufferedSocketSession } from "./bufferedSocketSession.ts";
import { joinText } from "./joinText.ts";

/**
 * iApp's realtime speech-to-text, over its `realtime-v2` WebSocket
 * (`wss://api.iapp.co.th/v3/store/speech/speech-to-text/realtime-v2`).
 *
 * The wire, as confirmed live (testdata/OBSERVATIONS.md, "iApp realtime"):
 *
 * - The key goes in an `apikey` header (a bad key is an HTTP 401 before the
 *   upgrade). The client speaks first, with a JSON settings message; the
 *   server answers `{"type":"ready"}`, and audio is held until it arrives.
 * - Audio is binary PCM16, 16 kHz, mono. The turn ends with the text message
 *   `end`; the server then sends the remaining finals, `{"type":"done",
 *   "audio_seconds","utterances"}`, and closes.
 * - `partial` carries the running text of one utterance (each replaces the one
 *   before); `final` closes it. A sentence ends after a pause of
 *   `end_silence_ms`, so a recording yields one final per sentence.
 * - Errors arrive as `{"type":"error","code","message"}`.
 *
 * Thai only. English words come back written in Thai script (the vendor
 * documents this), and English speech comes back as nonsense, so this is for
 * Thai speakers. The model cannot be chosen: `model` names what the vendor
 * reported in `ready` and is only the configuration's label.
 *
 * It accepts audio faster than real time (9.2 s at once finished in about
 * 1.7 s, 37 s in 2.5 s, same text) but answers `TOO_FAST` and ends the session
 * once more than 120 s of audio is waiting, so a long recording is paced (see
 * {@link MAX_BACKLOG_SECONDS}).
 *
 * Free while the vendor is in launch (their docs, 2026-11-14); the price is an
 * option so it can be set when one is published.
 */

export const IAPP_DEFAULT_MODEL = "chinda-asr-realtime-v1";

/** USD per second. The vendor lists none: free during launch. */
export const IAPP_PRICE_PER_SECOND = 0;

/** 100 ms of 16 kHz 16-bit mono: the vendor advises 100–200 ms, and allows at most 1 s. */
const CHUNK_SIZE = 3200;

/**
 * The vendor ends the session with `TOO_FAST` when more than 120 s of audio is
 * waiting to be processed. This much may be sent at once; after that audio goes
 * out at {@link CATCH_UP_FACTOR} times real time, which the vendor outpaces
 * (it cleared 37 s in 2.5 s) with room to spare.
 */
export const MAX_BACKLOG_SECONDS = 90;
export const CATCH_UP_FACTOR = 2;

/** How often a paced recording checks whether more audio may go out. */
const PACE_TICK_MS = 50;

const DEFAULT_URL = "wss://api.iapp.co.th/v3/store/speech/speech-to-text/realtime-v2";

export interface IAppProviderConfig {
  apiKey: string;
  model?: string;
  /** Endpoint. Overridden in tests. */
  url?: string;
  /** USD per second of audio. Overrides {@link IAPP_PRICE_PER_SECOND}. */
  pricePerSecond?: number;
  /**
   * The vendor's `latency_ms` (80, 320, 560 or 1120). Default **560**, the
   * vendor's: 80 gives partials about three times as often but changed the
   * Thai spelling of "MongoDB" on the test fixture (dropping a syllable), and
   * 320 changed two spellings.
   */
  latencyMs?: number;
  /** The vendor's `end_silence_ms` (300–3000): the pause that ends a sentence. Default the vendor's 700. */
  endSilenceMs?: number;
}

interface ServerEvent {
  type?: string;
  utterance?: number;
  text?: string;
  code?: string;
  message?: string;
}

export function createIAppProvider(config: IAppProviderConfig): ASRProvider {
  const model = config.model ?? IAPP_DEFAULT_MODEL;
  const pricePerSecond = config.pricePerSecond ?? IAPP_PRICE_PER_SECOND;
  const url = config.url ?? DEFAULT_URL;
  const settings: Record<string, unknown> = {
    language_code: "th",
    sample_rate: 16000,
    encoding: "pcm_s16le",
  };
  if (config.latencyMs !== undefined) settings.latency_ms = config.latencyMs;
  if (config.endSilenceMs !== undefined) settings.end_silence_ms = config.endSilenceMs;

  return {
    createSession(callbacks: ASRCreateSessionOptions): ASRSession {
      const ws = new WebSocket(url, { headers: { apikey: config.apiKey } });

      let readyAt = 0;
      let endRequested = false;
      let endSent = false;
      let queue: Buffer[] = [];
      let sentBytes = 0;
      let paceTimer: ReturnType<typeof setTimeout> | undefined;
      // Finals by utterance index, and the running text of the utterance being heard.
      const finals = new Map<number, string>();
      let interimUtterance = -1;
      let interim = "";
      let done = false;
      let abandoned = false;

      const finalText = () =>
        [...finals.entries()]
          .sort((a, b) => a[0] - b[0])
          .reduce((all, [, text]) => joinText(all, text), "");

      /**
       * Send what the backlog allowance permits, and `end` once everything is
       * out. The allowance grows with time since `ready`, so a long recording
       * dumped at once is released in steps instead of tripping `TOO_FAST`.
       */
      function pump() {
        clearTimeout(paceTimer);
        if (!readyAt || done || abandoned) return;
        const allowed =
          (MAX_BACKLOG_SECONDS + ((Date.now() - readyAt) / 1000) * CATCH_UP_FACTOR) *
          BYTES_PER_SECOND;
        while (queue.length > 0 && sentBytes + queue[0]!.length <= allowed) {
          const chunk = queue.shift()!;
          sentBytes += chunk.length;
          ws.send(chunk);
        }
        if (queue.length > 0) {
          paceTimer = setTimeout(pump, PACE_TICK_MS);
        } else if (endRequested && !endSent) {
          endSent = true;
          ws.send("end");
        }
      }

      function fail(error: Error) {
        if (done) return;
        done = true;
        clearTimeout(paceTimer);
        callbacks.onError?.(error);
        ws.close();
      }

      function complete(audioSeconds: number) {
        if (done) return;
        done = true;
        clearTimeout(paceTimer);
        const text = finalText();
        if (text.trim()) callbacks.onFinal?.(text);
        callbacks.onUsage?.([
          { sku: `iapp:${model}:seconds`, unitPrice: pricePerSecond, quantity: audioSeconds },
        ]);
        callbacks.onEnd?.();
        ws.close(1000, "done");
      }

      const session = createBufferedSocketSession({
        ws,
        chunkSize: CHUNK_SIZE,
        sendHandshake() {
          ws.send(JSON.stringify(settings));
        },
        sendChunk(chunk) {
          queue.push(Buffer.from(chunk));
          pump();
        },
        endTurn(remaining) {
          if (remaining.length > 0) queue.push(Buffer.from(remaining));
          endRequested = true;
          pump();
        },
        handleMessage(raw) {
          let event: ServerEvent;
          try {
            event = JSON.parse(raw.toString("utf8"));
          } catch {
            return;
          }
          if (done) return;
          if (event.type === "ready") {
            if (readyAt) return;
            readyAt = Date.now();
            pump();
          } else if (event.type === "partial") {
            interimUtterance = event.utterance ?? -1;
            interim = event.text ?? "";
            const running = joinText(finalText(), interim);
            if (running) callbacks.onPartial?.(running);
          } else if (event.type === "final") {
            finals.set(event.utterance ?? finals.size, event.text ?? "");
            if (interimUtterance === event.utterance) interim = "";
            const running = joinText(finalText(), interim);
            if (running) callbacks.onPartial?.(running);
          } else if (event.type === "done") {
            // Billed by what the vendor counted; fall back to what we sent.
            const reported = (event as { audio_seconds?: number }).audio_seconds;
            complete(typeof reported === "number" ? reported : sentBytes / BYTES_PER_SECOND);
          } else if (event.type === "error") {
            fail(new Error(`iApp ${event.code ?? "error"}: ${event.message ?? "no detail"}`));
          }
        },
        onError(err) {
          fail(err);
        },
      });

      // The vendor closes the socket after `done` and after most errors. Closing
      // before either means the transcript is not coming.
      ws.on("close", () => {
        if (abandoned || done) return;
        fail(new Error("iApp connection closed before the transcript was done"));
      });

      return {
        ...session,
        close() {
          // The caller hanging up is not a failure.
          abandoned = true;
          clearTimeout(paceTimer);
          session.close();
        },
      };
    },
  };
}
