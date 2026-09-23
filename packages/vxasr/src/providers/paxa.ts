import type { ASRCreateSessionOptions, ASRProvider, ASRSession } from "../asr.ts";
import { createBatchSession } from "./batchSession.ts";

/**
 * Paxa Labs' speech-to-text endpoint — a batch HTTP call like
 * `./openrouter.ts`, not a realtime protocol, so it sits behind
 * `createBatchSession` (`./batchSession.ts`): the whole clip is sent as one
 * base64 WAV once `finish()` is called.
 *
 * Unlike OpenRouter's multipart upload, this one takes JSON with the audio
 * base64-encoded in the body (https://paxalabs.com/docs/speech-to-text).
 *
 * Tried live against the same fixtures the rest of `testdata/OBSERVATIONS.md`
 * uses (dtinth/vxbeamer#86). Of everything compared there it needed the least
 * coaxing: no filler tags, no spaces inserted between Thai words, no English
 * translated into Thai, and the same transcript on all three runs of every
 * clip — none of which the models behind the other providers manage without
 * an instruction telling them to.
 */
export interface PaxaProviderConfig {
  apiKey: string;
  model?: string;
  /**
   * How numbers and repeated words are written. `spoken` (the vendor's
   * default) spells a number the way it is said; `written` uses digits and
   * the Thai repetition mark. Left at the vendor's default here — the
   * difference does not show up at all on clips without numbers, so picking
   * one for everybody would be a guess rather than a decision.
   */
  convention?: "spoken" | "written";
  /** Endpoint. Overridden in tests. */
  baseUrl?: string;
}

const DEFAULT_BASE_URL = "https://api.paxalabs.com/v1/stt";

export const PAXA_DEFAULT_MODEL = "paxa-stt-lite-v1-preview";

/**
 * 8.33 credits per minute, and 10,000 credits cost ฿329 — so a credit is
 * ฿0.0329, and an hour of audio is ฿16.45. Converted at ฿35/USD, which is
 * the one number here that is not the vendor's: a rate moves, so treat this
 * as approximate in a way the others are not.
 */
const PAXA_CREDITS_PER_SECOND = 8.33 / 60;
const PAXA_USD_PER_CREDIT = 329 / 10_000 / 35;

interface PaxaResponse {
  text?: string;
  usage?: { seconds?: number; credits?: number };
}

export function createPaxaProvider(config: PaxaProviderConfig): ASRProvider {
  const model = config.model ?? PAXA_DEFAULT_MODEL;
  const url = config.baseUrl ?? DEFAULT_BASE_URL;

  return {
    createSession(options: ASRCreateSessionOptions): ASRSession {
      return createBatchSession(options, async (wav, signal) => {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            audio: Buffer.from(wav).toString("base64"),
            model,
            ...(config.convention ? { convention: config.convention } : {}),
          }),
          signal,
        });
        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(`Paxa STT ${response.status}: ${body}`);
        }

        const data = (await response.json()) as PaxaResponse;
        // The vendor reports both the seconds it billed and the credits they
        // cost. Seconds are the honest quantity for a rate × amount record, so
        // credits are only used to derive the rate — and when the response
        // carries neither, nothing is billed rather than a guess.
        const seconds = data.usage?.seconds;
        return {
          text: data.text ?? "",
          usage:
            typeof seconds === "number" && seconds > 0
              ? [
                  {
                    sku: `paxa:${model}:seconds`,
                    unitPrice: PAXA_CREDITS_PER_SECOND * PAXA_USD_PER_CREDIT,
                    quantity: seconds,
                  },
                ]
              : [],
        };
      });
    },
  };
}
