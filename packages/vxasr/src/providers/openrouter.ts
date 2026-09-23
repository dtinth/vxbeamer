import type { BlobPart } from "node:buffer";
import type { ASRCreateSessionOptions, ASRProvider, ASRSession } from "../asr.ts";
import { createBatchSession } from "./batchSession.ts";

/**
 * OpenRouter's audio transcription endpoint — a plain batch HTTP call, not a
 * realtime protocol like the streaming providers here. It sits behind
 * `createBatchSession` (`./batchSession.ts`): the whole clip is sent as one
 * WAV file once `finish()` is called, and the transcript comes back in a
 * single response.
 *
 * OpenRouter fans out to many backing vendors under one API and one key, so
 * `model` names the *router's* model id (e.g. `microsoft/mai-transcribe-1.5`),
 * not a vendor-native one — see
 * https://openrouter.ai/docs/api/api-reference/stt/create-transcription.
 * Compared live against sibling OpenRouter STT models on the same fixture
 * `testdata/OBSERVATIONS.md` uses (dtinth/vxbeamer#86); `mai-transcribe-1.5`,
 * `mai-transcribe-2`, and `muse-voice-transcribe-1.0` are the ones declared
 * as configurations so far. `mai-transcribe-2` leads because it was the
 * fastest and cheapest of the three once they were timed rather than only
 * read — see the note on the models list in `./builtin.ts`.
 */
export interface OpenRouterProviderConfig {
  apiKey: string;
  model?: string;
  /** Endpoint. Overridden in tests. */
  baseUrl?: string;
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1/audio/transcriptions";

export const OPENROUTER_DEFAULT_MODEL = "microsoft/mai-transcribe-2";

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
      return createBatchSession(options, async (wav, signal) => {
        const form = new FormData();
        form.append("model", model);
        form.append("file", new Blob([wav as BlobPart], { type: "audio/wav" }), "audio.wav");
        const response = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${config.apiKey}` },
          body: form,
          signal,
        });
        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(`OpenRouter STT ${response.status}: ${body}`);
        }

        const data = (await response.json()) as OpenRouterTranscriptionResponse;
        return {
          text: data.text ?? "",
          // The router reports the actual USD charge directly, unlike every
          // per-second or per-token vendor here — quantity 1 at that price is
          // the honest way to fit that into a rate × amount record.
          usage:
            typeof data.usage?.cost === "number"
              ? [{ sku: `openrouter:${model}:cost`, unitPrice: data.usage.cost, quantity: 1 }]
              : [],
        };
      });
    },
  };
}
