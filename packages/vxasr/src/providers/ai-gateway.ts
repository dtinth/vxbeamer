import { createGateway } from "@ai-sdk/gateway";
import { experimental_streamTranscribe, type TranscriptionStreamPart } from "ai";
import type { ASRCreateSessionOptions, ASRProvider, ASRSession } from "../asr.ts";
import { BYTES_PER_SECOND, SAMPLE_RATE } from "../audio.ts";

/**
 * Streaming transcription through the Vercel AI Gateway
 * (https://vercel.com/docs/ai-gateway/modalities/speech-to-text), with the
 * AI SDK's `experimental_streamTranscribe`: the gateway holds the WebSocket to
 * the model's own vendor, and the SDK is the documented way to speak to it,
 * so this provider uses the SDK rather than a hand-written wire protocol.
 *
 * Added for `microsoft/mai-transcribe-2-streaming`, which is offered only
 * here. Tried live before this was written (dtinth/vxbeamer#86):
 *
 * - The stream gives `transcript-delta` (finalized text, to append) and
 *   `transcript-partial` (the provisional text *after* the latest delta), so
 *   the text so far is the deltas joined plus the current partial.
 * - Once the input ends, one `transcript-final` carries the whole transcript,
 *   pauses and all: on three sentences with pauses between them, every
 *   sentence was kept. It came 0.33–0.49 s after the audio ended.
 * - For silence the final is empty, and the SDK's `text` promise then rejects
 *   with "No transcript generated", so only `fullStream` is read here.
 * - A whole clip sent at once works: 3.2 s for a 9.2 s clip.
 */
export interface AIGatewayProviderConfig {
  apiKey: string;
  model?: string;
  /**
   * The SDK call. Overridden in tests, which replace the gateway with a
   * scripted stream of parts.
   */
  streamTranscribe?: (options: {
    apiKey: string;
    model: string;
    audio: ReadableStream<Uint8Array>;
    abortSignal: AbortSignal;
  }) => { fullStream: AsyncIterable<TranscriptionStreamPart> };
}

export const AI_GATEWAY_DEFAULT_MODEL = "microsoft/mai-transcribe-2-streaming";

/** $0.54 per hour of audio, the gateway's listed price for the default model. */
const AI_GATEWAY_USD_PER_SECOND = 0.54 / 3600;

function streamThroughGateway(options: {
  apiKey: string;
  model: string;
  audio: ReadableStream<Uint8Array>;
  abortSignal: AbortSignal;
}) {
  const gateway = createGateway({ apiKey: options.apiKey });
  return experimental_streamTranscribe({
    model: gateway.transcriptionModel(options.model),
    audio: options.audio,
    inputAudioFormat: { type: "audio/pcm", rate: SAMPLE_RATE },
    abortSignal: options.abortSignal,
  });
}

export function createAIGatewayProvider(config: AIGatewayProviderConfig): ASRProvider {
  const model = config.model ?? AI_GATEWAY_DEFAULT_MODEL;
  const stream = config.streamTranscribe ?? streamThroughGateway;

  return {
    createSession(callbacks: ASRCreateSessionOptions): ASRSession {
      const controller = new AbortController();
      let audio!: ReadableStreamDefaultController<Uint8Array>;
      const input = new ReadableStream<Uint8Array>({
        start(c) {
          audio = c;
        },
      });

      let totalBytesSent = 0;
      let finishing = false;
      let closed = false;

      void (async () => {
        let committed = "";
        let final: string | undefined;
        try {
          const result = stream({
            apiKey: config.apiKey,
            model,
            audio: input,
            abortSignal: controller.signal,
          });
          for await (const part of result.fullStream) {
            if (closed) return;
            if (part.type === "transcript-delta") {
              committed += part.delta;
              callbacks.onPartial?.(committed);
            } else if (part.type === "transcript-partial") {
              callbacks.onPartial?.(committed + part.text);
            } else if (part.type === "transcript-final") {
              final = part.text;
            } else if (part.type === "error") {
              throw part.error instanceof Error ? part.error : new Error(String(part.error));
            }
          }
        } catch (err) {
          if (closed) return; // close() aborted the stream
          callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        if (closed) return;

        callbacks.onFinal?.(final ?? committed);
        const seconds = totalBytesSent / BYTES_PER_SECOND;
        if (seconds > 0) {
          callbacks.onUsage?.([
            {
              sku: `ai-gateway:${model}:seconds`,
              unitPrice: AI_GATEWAY_USD_PER_SECOND,
              quantity: seconds,
            },
          ]);
        }
        callbacks.onEnd?.();
      })();

      return {
        sendAudio(chunk: Buffer) {
          if (finishing || closed) return;
          totalBytesSent += chunk.length;
          audio.enqueue(new Uint8Array(chunk));
        },
        finish() {
          if (finishing || closed) return;
          finishing = true;
          audio.close();
        },
        close() {
          if (closed) return;
          closed = true;
          controller.abort();
        },
      };
    },
  };
}
