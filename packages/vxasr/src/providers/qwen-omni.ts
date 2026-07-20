import WebSocket from "ws";
import type { ASRProvider, ASRSession, ASRSessionCallbacks, UsageRecord } from "../asr.ts";

/**
 * The Qwen **Omni Realtime** models, which are not ASR models at all: they are
 * omni-modal chat models that happen to hear. They share a host, an auth header
 * and a URL shape with `./qwen.ts`, and nothing else — which is why they are a
 * separate provider rather than more models under `qwen`:
 *
 * - **Different protocol.** The turn ends with `input_audio_buffer.commit` +
 *   `response.create`, and the transcript arrives on `response.text.*`. There is
 *   no `session.finish` — that message belongs to the ASR protocol, and sending
 *   it to these models is exactly why `qwen` times out against them.
 * - **Different billing.** Tokens, not audio-seconds, at rates that differ per
 *   model. `qwen`'s per-second SKU cannot describe this.
 * - **Different instrument.** An ASR model transcribes because that is all it
 *   can do. These models transcribe only because {@link
 *   QWEN_OMNI_TRANSCRIPTION_INSTRUCTIONS} tells them to; left to themselves they
 *   hold a conversation about what they heard.
 *
 * One provider id therefore means one wire protocol, which is what the registry
 * seam exists to keep true. Folding these in under `qwen` would put a
 * switch-on-model-id inside `createQwenProvider` choosing between two protocols,
 * and would let `ASR_PROVIDER=qwen ASR_MODEL=qwen3.5-omni-…` silently speak a
 * protocol the provider's own name does not describe.
 */

/** 16 kHz 16-bit mono. */
const CHUNK_SIZE = 3200; // 100 ms

/**
 * What makes these models transcribers rather than chatbots.
 *
 * This is **not** a tuning knob, and deliberately not configurable. Sending
 * `response.create` with no instructions does not produce a worse transcript, it
 * produces a *conversation*: on the Thai test fixture the model replied, in
 * Thai, offering to help design the project described in the clip. So the
 * instruction is load-bearing input, on a par with `input_audio_format`.
 *
 * It is a constant rather than part of a configuration's identity because
 * identity is provider + model + post-processing chain (see
 * `../configuration.ts`), and an instruction is none of those. If it were an
 * env var or a config field, an operator could change what the model was asked
 * to do — the single thing that decides whether output is a transcript at all —
 * without any configuration id changing, so a vote would name a moving target.
 * That is precisely the drift the pinned-snapshot rule guards against, arriving
 * through a different door. Evaluating a second instruction is a real thing to
 * want, but it needs an identity component that can express it; until then, one
 * adapter asks one question.
 */
export const QWEN_OMNI_TRANSCRIPTION_INSTRUCTIONS =
  "Transcribe the user's audio verbatim. Output only the transcript, nothing else.";

/**
 * USD per token. The vendor prices audio input and text input differently —
 * unlike Groq, whose decorator charges one input rate — so an honest cost needs
 * all three.
 */
export interface QwenOmniTokenPricing {
  readonly inputAudioPerToken: number;
  readonly inputTextPerToken: number;
  readonly outputTextPerToken: number;
}

/**
 * Published rates for the **Singapore** region, which is what `dashscope-intl`
 * serves, per 1M tokens → per token.
 *
 * Rates are per *model*, not per provider: the table exists because a single
 * constant would be wrong for two of these three. They are also region-specific
 * and change without notice, so this table is the one place to edit them, and
 * {@link QwenOmniProviderConfig.pricing} overrides it for a deployment billed at
 * different rates.
 *
 * Worth knowing when reading a cost: rates alone do not rank these models.
 * `qwen3-omni-flash-realtime` is priced within pennies of `qwen3.5-omni-flash-realtime`
 * yet costs ~58% more per recording, because the older generation tokenises the
 * same audio far less efficiently (125 audio tokens vs 70 on a 9.2 s clip) and
 * is wordier. That is only visible because usage is reported as measured rather
 * than estimated from duration.
 */
export const QWEN_OMNI_PRICING: Readonly<Record<string, QwenOmniTokenPricing>> = {
  // audio $4.50 / text $0.55 / output $17.70 per 1M
  "qwen3.5-omni-flash-realtime-2026-03-15": {
    inputAudioPerToken: 4.5e-6,
    inputTextPerToken: 0.55e-6,
    outputTextPerToken: 17.7e-6,
  },
  // audio $16.50 / text $2.10 / output $62.00 per 1M
  "qwen3.5-omni-plus-realtime-2026-03-15": {
    inputAudioPerToken: 16.5e-6,
    inputTextPerToken: 2.1e-6,
    outputTextPerToken: 62.0e-6,
  },
  // audio $4.57 / text $0.52 / output $18.13 per 1M
  "qwen3-omni-flash-realtime-2025-12-01": {
    inputAudioPerToken: 4.57e-6,
    inputTextPerToken: 0.52e-6,
    outputTextPerToken: 18.13e-6,
  },
};

export const QWEN_OMNI_DEFAULT_MODEL = "qwen3.5-omni-flash-realtime-2026-03-15";

export interface QwenOmniProviderConfig {
  apiKey: string;
  /** A model id from {@link QWEN_OMNI_PRICING}. */
  model?: string;
  /** Endpoint, without the `?model=` query. Overridden in tests. */
  baseUrl?: string;
  /** Overrides {@link QWEN_OMNI_PRICING} for this model — rates are regional. */
  pricing?: QwenOmniTokenPricing;
}

const DEFAULT_BASE_URL = "wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime";

interface OmniUsage {
  input_tokens_details?: { audio_tokens?: number; text_tokens?: number };
  output_tokens_details?: { text_tokens?: number };
}

/** Reports what the vendor measured, and stays silent about what it did not. */
function buildUsageRecords(
  model: string,
  pricing: QwenOmniTokenPricing,
  usage: OmniUsage | undefined,
): UsageRecord[] {
  const audioTokens = usage?.input_tokens_details?.audio_tokens ?? 0;
  const textTokens = usage?.input_tokens_details?.text_tokens ?? 0;
  const outputTokens = usage?.output_tokens_details?.text_tokens ?? 0;

  return [
    {
      sku: `dashscope:${model}:input-audio-tokens`,
      unitPrice: pricing.inputAudioPerToken,
      quantity: audioTokens,
    },
    {
      sku: `dashscope:${model}:input-text-tokens`,
      unitPrice: pricing.inputTextPerToken,
      quantity: textTokens,
    },
    {
      sku: `dashscope:${model}:output-text-tokens`,
      unitPrice: pricing.outputTextPerToken,
      quantity: outputTokens,
    },
  ];
}

export function createQwenOmniProvider(config: QwenOmniProviderConfig): ASRProvider {
  const model = config.model ?? QWEN_OMNI_DEFAULT_MODEL;
  const pricing = config.pricing ?? QWEN_OMNI_PRICING[model];
  if (!pricing) {
    // The registry allowlists models before we are reached, so a model with no
    // rates is a programming error rather than a request failure. Charging $0
    // silently would be worse than refusing to start.
    throw new Error(
      `No pricing for Qwen Omni model "${model}" (known: ${Object.keys(QWEN_OMNI_PRICING).join(", ")})`,
    );
  }

  const url = `${config.baseUrl ?? DEFAULT_BASE_URL}?model=${model}`;

  return {
    createSession(callbacks: ASRSessionCallbacks): ASRSession {
      const ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });

      let buffer = Buffer.alloc(0);
      let ready = false;
      let finishing = false;
      let closed = false;
      let transcript = "";

      function flushBuffer() {
        while (buffer.length >= CHUNK_SIZE) {
          const chunk = buffer.subarray(0, CHUNK_SIZE);
          buffer = buffer.subarray(CHUNK_SIZE);
          append(chunk);
        }
      }

      function append(audio: Buffer) {
        ws.send(
          JSON.stringify({
            event_id: `event_${Date.now()}`,
            type: "input_audio_buffer.append",
            audio: audio.toString("base64"),
          }),
        );
      }

      /**
       * Ends the turn. Unlike the ASR protocol, committing the buffer only
       * closes the *input*: the model does nothing until `response.create` asks
       * it for one. There is no `session.finish` here.
       */
      function doFinish() {
        if (buffer.length > 0) {
          append(buffer);
          buffer = Buffer.alloc(0);
        }
        ws.send(JSON.stringify({ event_id: "event_commit", type: "input_audio_buffer.commit" }));
        ws.send(JSON.stringify({ event_id: "event_response", type: "response.create" }));
      }

      ws.on("open", () => {
        ws.send(
          JSON.stringify({
            event_id: "event_session",
            type: "session.update",
            session: {
              modalities: ["text"],
              // `pcm`, not the `pcm16` the OpenAI realtime protocol names.
              input_audio_format: "pcm",
              sample_rate: 16000,
              // Manual turn-taking: the recording decides when the turn ends,
              // not a silence detector.
              turn_detection: null,
              instructions: QWEN_OMNI_TRANSCRIPTION_INSTRUCTIONS,
              // Silences the transcription sub-service. This field names a
              // *separate* ASR model that runs alongside and transcribes our
              // audio independently — it is not this model, and its output
              // differs (it renders `project` in Latin where the omni model
              // renders `โปรเจกต์` in Thai). Naming no model turns it off
              // entirely: with the field omitted the vendor picks one and
              // streams events we would only ignore, for a second model's worth
              // of audio we never asked to be heard by. Verified: `{}` yields
              // zero `conversation.item.input_audio_transcription.*` events.
              input_audio_transcription: {},
            },
          }),
        );
        ready = true;
        flushBuffer();
        // A clip short enough to finish before the socket opened still has to
        // be sent, or no response is ever requested and the session hangs.
        if (finishing) doFinish();
      });

      ws.on("message", (raw: Buffer) => {
        if (closed) return;
        const data = JSON.parse(raw.toString());

        if (data.type === "response.text.delta") {
          // Deltas are incremental, so the running text is what a partial is.
          transcript += data.delta ?? "";
          callbacks.onPartial?.(transcript);
        } else if (data.type === "response.text.done") {
          transcript = data.text ?? transcript;
          callbacks.onFinal?.(transcript);
        } else if (data.type === "response.done") {
          // Usage lands here, after the text — so this, not `response.text.done`,
          // is where a session ends.
          callbacks.onUsage?.(buildUsageRecords(model, pricing, data.response?.usage));
          callbacks.onEnd?.();
          ws.close(1000, "done");
        } else if (data.type === "error") {
          callbacks.onError?.(new Error(JSON.stringify(data)));
          // The turn is over and will produce nothing, so hang up rather than
          // hold the socket open. A session that has errored still counts
          // against the vendor's 120-minute session cap until it closes.
          ws.close();
        }
      });

      ws.on("error", (err: Error) => {
        if (closed) return;
        callbacks.onError?.(err);
        // A transport error leaves the socket half-open; close it so its slot in
        // the vendor's connection pool is released rather than lingering.
        ws.close();
      });

      return {
        sendAudio(chunk: Buffer) {
          if (finishing) return;
          buffer = Buffer.concat([buffer, chunk]);
          if (ready) flushBuffer();
        },

        finish() {
          if (finishing) return;
          finishing = true;
          if (ready) doFinish();
          // else: the `open` handler calls doFinish() once the session is set up.
        },

        close() {
          if (closed) return;
          closed = true;
          // Stop feeding and finishing; from here the socket is being torn down,
          // not wound down. `terminate` releases the connection immediately in
          // any state (CONNECTING included), which `close()` cannot promise.
          finishing = true;
          ws.terminate();
        },
      };
    },
  };
}
