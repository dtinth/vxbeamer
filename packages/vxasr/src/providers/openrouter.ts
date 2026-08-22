import type { ASRCreateSessionOptions, ASRProvider, ASRSession } from "../asr.ts";
import { writeWav } from "../audio.ts";

/**
 * OpenRouter's audio transcription endpoint — a plain batch HTTP call, not a
 * realtime protocol like every other provider here. The whole clip is
 * buffered client-side and sent as one WAV file the moment `finish()` is
 * called; the transcript comes back in a single response. There is no
 * partial output — `onPartial` never fires for this provider, and pacing
 * `sendAudio` calls (realtime vs. a fast dump) makes no difference, since
 * nothing goes over the wire until the whole clip is in hand.
 *
 * OpenRouter fans out to many backing vendors under one API and one key, so
 * `model` names the *router's* model id (e.g. `microsoft/mai-transcribe-1.5`),
 * not a vendor-native one — see
 * https://openrouter.ai/docs/api/api-reference/stt/create-transcription.
 * Compared live against 18 sibling OpenRouter STT models on the same fixture
 * `testdata/OBSERVATIONS.md` uses (dtinth/vxbeamer#86); `mai-transcribe-1.5`
 * is the one declared as a configuration for now.
 */
export interface OpenRouterProviderConfig {
  apiKey: string;
  model?: string;
  /** Endpoint. Overridden in tests. */
  baseUrl?: string;
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1/audio/transcriptions";

export const OPENROUTER_DEFAULT_MODEL = "microsoft/mai-transcribe-1.5";

interface OpenRouterTranscriptionResponse {
  text?: string;
  /** Present on every model tested; absent is treated as "nothing to bill". */
  usage?: { cost?: number };
}

export function createOpenRouterProvider(config: OpenRouterProviderConfig): ASRProvider {
  const model = config.model ?? OPENROUTER_DEFAULT_MODEL;
  const url = config.baseUrl ?? DEFAULT_BASE_URL;

  return {
    createSession(options: ASRCreateSessionOptions): ASRSession {
      let chunks: Buffer[] = [];
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
          chunks = [];

          void (async () => {
            let response: Response;
            try {
              const wav = Buffer.from(writeWav(pcm));
              const form = new FormData();
              form.append("model", model);
              form.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
              response = await fetch(url, {
                method: "POST",
                headers: { Authorization: `Bearer ${config.apiKey}` },
                body: form,
                signal: controller.signal,
              });
            } catch (err) {
              if (closed) return; // close() aborted the in-flight request
              options.onError?.(err instanceof Error ? err : new Error(String(err)));
              return;
            }
            if (closed) return;

            if (!response.ok) {
              const body = await response.text().catch(() => "");
              options.onError?.(new Error(`OpenRouter STT ${response.status}: ${body}`));
              return;
            }

            const data = (await response.json()) as OpenRouterTranscriptionResponse;
            options.onFinal?.(data.text ?? "");
            if (typeof data.usage?.cost === "number") {
              // The router reports the actual USD charge directly, unlike every
              // per-second or per-token vendor here — quantity 1 at that price
              // is the honest way to fit that into a rate × amount record.
              options.onUsage?.([
                { sku: `openrouter:${model}:cost`, unitPrice: data.usage.cost, quantity: 1 },
              ]);
            }
            options.onEnd?.();
          })();
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
