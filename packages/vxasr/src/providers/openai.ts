import WebSocket from "ws";
import type { ASRCreateSessionOptions, ASRProvider, ASRSession } from "../asr.ts";
import { BYTES_PER_SECOND, SAMPLE_RATE } from "../audio.ts";
import { LinearResampler } from "../resample.ts";
import { createBufferedSocketSession } from "./bufferedSocketSession.ts";

/**
 * OpenAI's realtime transcription model, over the Realtime API's transcription
 * intent (`?intent=transcription`). Confirmed live against the real endpoint:
 * `session.update` sets `session.type: "transcription"` and the model under
 * `audio.input.transcription.model`; the turn ends with
 * `input_audio_buffer.commit` alone — there is no `response.create` step, since
 * a transcription session never generates a model *response*, only a
 * transcript of what it heard. Partials arrive as
 * `conversation.item.input_audio_transcription.delta` (incremental fragments,
 * not the running text — confirmed by concatenating a live session's deltas
 * and comparing against the final `.completed` transcript), and the turn
 * closes with `.completed` carrying the full transcript.
 *
 * On the test fixture (Thai speech with English technical loanwords) the
 * output rendered every loanword in Latin script and everything else in Thai
 * — the same bar Qwen Omni clears without Groq formatting — so this is
 * declared raw-only too; see `../builtin.ts`.
 */

/** 16 kHz 16-bit mono, the ASRSession contract's input format. */
const CHUNK_SIZE = 3200; // 100 ms

/**
 * The vendor requires audio at 24 kHz or above — a 16 kHz `format.rate`
 * is rejected outright ("integer below minimum value... Expected a value >=
 * 24000"). Every other provider in this package accepts the 16 kHz PCM the
 * app captures, so upsampling belongs here rather than in the shared audio
 * pipeline: it is what *this* vendor's wire needs, not a property of the
 * audio itself. See `../resample.ts` for the resampler and why it is stateful
 * across chunks.
 */
const VENDOR_SAMPLE_RATE = 24000;

/** USD per second of audio — the vendor's own rate is $0.017/minute, flat. */
const OPENAI_LIVE_TRANSCRIBE_PRICE_PER_SECOND = 0.017 / 60;

export const OPENAI_DEFAULT_MODEL = "gpt-live-transcribe";

export interface OpenAIProviderConfig {
  apiKey: string;
  model?: string;
  /** Endpoint, without the `?intent=` query. Overridden in tests. */
  baseUrl?: string;
}

const DEFAULT_BASE_URL = "wss://api.openai.com/v1/realtime";

export function createOpenAIProvider(config: OpenAIProviderConfig): ASRProvider {
  const model = config.model ?? OPENAI_DEFAULT_MODEL;
  const url = `${config.baseUrl ?? DEFAULT_BASE_URL}?intent=transcription`;

  return {
    createSession(callbacks: ASRCreateSessionOptions): ASRSession {
      const ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
      });

      let transcript = "";
      // Billed on what our own pipeline sent, at its native 16 kHz — not on the
      // upsampled wire bytes, which would overcount by the resample ratio.
      let totalBytesSent = 0;
      // One resampler per session: it carries the last sample as state so a
      // clip fed in many small chunks resamples identically to the same clip
      // fed in one — see ../resample.ts.
      const resampler = new LinearResampler(SAMPLE_RATE, VENDOR_SAMPLE_RATE);

      const appendFrame = (audio: Buffer) => {
        totalBytesSent += audio.length;
        ws.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: resampler.push(audio).toString("base64"),
          }),
        );
      };

      return createBufferedSocketSession({
        ws,
        chunkSize: CHUNK_SIZE,
        sendChunk: appendFrame,
        sendHandshake() {
          ws.send(
            JSON.stringify({
              type: "session.update",
              session: {
                type: "transcription",
                audio: {
                  input: {
                    format: { type: "audio/pcm", rate: VENDOR_SAMPLE_RATE },
                    transcription: { model },
                    // The recording decides when the turn ends, not a silence
                    // detector — same manual turn-taking every other provider
                    // here uses.
                    turn_detection: null,
                  },
                },
              },
            }),
          );
        },
        // A transcription session never generates a model *response* — only
        // ordinary chat/omni sessions do that. Committing the input is the
        // whole turn-end; there is no further step to ask for anything.
        endTurn(remaining) {
          if (remaining.length > 0) appendFrame(remaining);
          ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        },
        handleMessage(raw) {
          const data = JSON.parse(raw.toString());

          if (data.type === "conversation.item.input_audio_transcription.delta") {
            // Deltas are incremental fragments, not the running text.
            transcript += data.delta ?? "";
            callbacks.onPartial?.(transcript);
          } else if (data.type === "conversation.item.input_audio_transcription.completed") {
            transcript = data.transcript ?? transcript;
            callbacks.onFinal?.(transcript);
            const seconds = Math.ceil(totalBytesSent / BYTES_PER_SECOND);
            callbacks.onUsage?.([
              {
                sku: `openai:${model}:seconds`,
                unitPrice: OPENAI_LIVE_TRANSCRIBE_PRICE_PER_SECOND,
                quantity: seconds,
              },
            ]);
            callbacks.onEnd?.();
            ws.close(1000, "done");
          } else if (data.type === "conversation.item.input_audio_transcription.failed") {
            callbacks.onError?.(new Error(JSON.stringify(data.error ?? data)));
            ws.close();
          } else if (data.type === "error") {
            callbacks.onError?.(new Error(JSON.stringify(data)));
            // The turn is over and will produce nothing, so hang up rather than
            // hold the socket open, matching every other provider here.
            ws.close();
          }
        },
        onError(err) {
          callbacks.onError?.(err);
        },
      });
    },
  };
}
