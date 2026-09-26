import WebSocket from "ws";
import type { ASRCreateSessionOptions, ASRProvider, ASRSession } from "../asr.ts";
import { BYTES_PER_SECOND } from "../audio.ts";
import { createBufferedSocketSession } from "./bufferedSocketSession.ts";

/**
 * Gemini 3.5 Transcribe Live, over the Gemini Live API's `BidiGenerateContent`
 * WebSocket (https://ai.google.dev/gemini-api/docs/live-api/live-transcribe),
 * in **push-to-talk** mode with **smart** transcription. Tried live before
 * this was written (dtinth/vxbeamer#86):
 *
 * - The key goes in the URL (`?key=`). A `setup` frame names the model,
 *   disables the vendor's voice detection, and asks for `SMART` mode (fillers
 *   and false starts removed). `activityStart` follows at once: audio sent
 *   before `setupComplete` is accepted.
 * - Audio is base64 PCM inside `realtimeInput` JSON frames, and the recording
 *   ends with `activityEnd`.
 * - Partials arrive about every 0.5 s as `interimInputTranscription`, and the
 *   final as `inputTranscription`, once, after `activityEnd`. The partials put
 *   spaces between Thai words; the final does not.
 * - `voiceActivity: ACTIVITY_END` always follows `activityEnd`, after the
 *   final, and also when there was only silence and so no final at all. That
 *   is where the session ends.
 * - A whole clip sent at once works: 3.3 s for a 9.2 s clip.
 * - A session can stream for 10 minutes at most.
 *
 * **Known risk, chosen knowingly.** In the same tests, push-to-talk with
 * `SMART` dropped a later sentence from clips joined from separate
 * recordings, every time; the vendor's automatic voice detection, which
 * splits turns at pauses, kept them all. Push-to-talk was chosen anyway, to
 * be revisited if it shows up in real use (dtinth/vxbeamer#86). Delaying the
 * stop a little is one workaround to try then.
 */
export interface GeminiLiveProviderConfig {
  apiKey: string;
  model?: string;
  /** Endpoint, without the `key` parameter. Overridden in tests. */
  baseUrl?: string;
  /** See {@link END_TIMEOUT_MS}. Overridden in tests. */
  endTimeoutMs?: number;
}

const DEFAULT_BASE_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export const GEMINI_LIVE_DEFAULT_MODEL = "gemini-3.5-transcribe-live";

const CHUNK_SIZE = 3200; // 100 ms at 16 kHz 16-bit mono, as the docs recommend

/**
 * The longest wait for `ACTIVITY_END` after the recording ends. It has always
 * come within about a second (3 s for a fast dump), so this only guards
 * against it never coming.
 */
const END_TIMEOUT_MS = 15_000;

/**
 * $0.005 per minute of audio in, and $0.004 per minute for the text out
 * (Google's pricing page, standard tier). The Live API reports no usage on
 * this path, so both are charged by the audio sent.
 */
const GEMINI_LIVE_USD_PER_SECOND = (0.005 + 0.004) / 60;

export function createGeminiLiveProvider(config: GeminiLiveProviderConfig): ASRProvider {
  const model = config.model ?? GEMINI_LIVE_DEFAULT_MODEL;
  const endTimeoutMs = config.endTimeoutMs ?? END_TIMEOUT_MS;

  return {
    createSession(callbacks: ASRCreateSessionOptions): ASRSession {
      const url = `${config.baseUrl ?? DEFAULT_BASE_URL}?key=${encodeURIComponent(config.apiKey)}`;
      const ws = new WebSocket(url);

      // Push-to-talk gives one final per recording, but joining costs nothing
      // and keeps every word if the vendor ever splits one.
      const finals: string[] = [];
      const joined = (...more: string[]) =>
        [...finals, ...more].filter((text) => text.length > 0).join(" ");
      let totalBytesSent = 0;
      let recordingEnded = false;
      let ended = false;
      let endTimer: ReturnType<typeof setTimeout> | undefined;

      const fail = (error: Error) => {
        if (ended) return;
        ended = true;
        clearTimeout(endTimer);
        callbacks.onError?.(error);
        ws.close();
      };

      const complete = () => {
        if (ended) return;
        ended = true;
        clearTimeout(endTimer);
        callbacks.onFinal?.(joined());
        const seconds = totalBytesSent / BYTES_PER_SECOND;
        if (seconds > 0) {
          callbacks.onUsage?.([
            {
              sku: `gemini:${model}:seconds`,
              unitPrice: GEMINI_LIVE_USD_PER_SECOND,
              quantity: seconds,
            },
          ]);
        }
        callbacks.onEnd?.();
        ws.close(1000, "done");
      };

      const send = (frame: object) => ws.send(JSON.stringify(frame));
      const sendAudio = (chunk: Buffer) => {
        totalBytesSent += chunk.length;
        send({
          realtimeInput: {
            audio: { data: chunk.toString("base64"), mimeType: "audio/pcm;rate=16000" },
          },
        });
      };

      const session = createBufferedSocketSession({
        ws,
        chunkSize: CHUNK_SIZE,
        sendChunk: sendAudio,
        sendHandshake() {
          send({
            setup: {
              model: `models/${model}`,
              generationConfig: { responseModalities: ["TEXT"] },
              realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
              // Removes fillers and false starts, and formats numbers and
              // punctuation. The vendor default is VERBATIM.
              inputAudioTranscription: { mode: "SMART" },
            },
          });
          send({ realtimeInput: { activityStart: {} } });
        },
        endTurn(remaining) {
          if (remaining.length > 0) sendAudio(remaining);
          send({ realtimeInput: { activityEnd: {} } });
          recordingEnded = true;
          endTimer = setTimeout(
            () => fail(new Error("Gemini Live: no end of activity after the recording ended")),
            endTimeoutMs,
          );
        },
        handleMessage(raw) {
          if (ended) return;
          const data = JSON.parse(raw.toString());

          const content = data.serverContent;
          if (content?.inputTranscription) {
            finals.push(content.inputTranscription.text ?? "");
            callbacks.onPartial?.(joined());
          } else if (content?.interimInputTranscription) {
            callbacks.onPartial?.(joined(content.interimInputTranscription.text ?? ""));
          }

          if (data.voiceActivity?.type === "ACTIVITY_END" && recordingEnded) {
            complete();
          } else if (data.error) {
            fail(new Error(`Gemini Live: ${JSON.stringify(data.error)}`));
          }
          // `setupComplete`, `generationComplete`, `ACTIVITY_START` and
          // `goAway` need no action: the socket closing is what matters, and
          // is handled below.
        },
        onError(err) {
          fail(err);
        },
      });

      // The service reports a bad setup, a bad key or the 10-minute limit by
      // closing the socket, with the reason as the close reason.
      ws.on("close", (code, reason) => {
        if (!ended) fail(new Error(`Gemini Live closed: ${code} ${reason.toString()}`));
      });

      return {
        sendAudio: (chunk) => session.sendAudio(chunk),
        finish: () => session.finish(),
        close() {
          // The caller hung up: nothing more is reported.
          ended = true;
          clearTimeout(endTimer);
          session.close();
        },
      };
    },
  };
}
