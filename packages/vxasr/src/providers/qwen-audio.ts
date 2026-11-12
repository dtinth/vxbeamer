import WebSocket from "ws";
import { randomUUID } from "crypto";
import type { ASRCreateSessionOptions, ASRProvider, ASRSession, UsageRecord } from "../asr.ts";
import { createBufferedSocketSession } from "./bufferedSocketSession.ts";
import { isValidWorkspaceId, redactWorkspaceId } from "./workspace.ts";

/**
 * Qwen-Audio-3.1-ASR over DashScope's duplex `run-task` protocol.
 *
 * Neither Qwen ASR provider here speaks it: `qwen` is the OpenAI-style realtime
 * ASR protocol and `qwen-omni` is a chat model behind `session.update`. This is
 * a third wire format — a `run-task` text frame, raw PCM as binary frames,
 * `finish-task` — and, unlike Omni, it transcribes *while the audio is still
 * arriving* (testdata/OBSERVATIONS.md, "Qwen-Audio-3.1-ASR").
 *
 * Two models share the protocol and differ in what they are for:
 *
 * - `qwen-audio-3.1-asr-flash-message` — short voice input. Its live partials
 *   are poor (it guesses the language from the first fraction of a second), but
 *   its final text is the better of the two.
 * - `qwen-audio-3.1-asr-flash-streaming` — continuous transcription. Partials
 *   become readable quickly; the final text has no word spaces.
 *
 * Audio may only be sent after the server's `task-started`, so chunks are held
 * until it arrives and `finish-task` waits behind them.
 *
 * Usage is the vendor's own measured token counts, reported once at the end.
 */
export interface QwenAudioTokenPricing {
  readonly inputPerToken: number;
  readonly outputPerToken: number;
}

/**
 * Singapore, per 1M tokens → per token.
 *
 * **Unverified.** The vendor's model-pricing page is too long for the fetch
 * tool, and these rows ($0.93 input / $0.70 output, identical for both models)
 * were only seen in a summary of it, not in page text — check them against the
 * live page before trusting a reported cost.
 */
export const QWEN_AUDIO_PRICING: Readonly<Record<string, QwenAudioTokenPricing>> = {
  "qwen-audio-3.1-asr-flash-message": { inputPerToken: 0.93e-6, outputPerToken: 0.7e-6 },
  "qwen-audio-3.1-asr-flash-streaming": { inputPerToken: 0.93e-6, outputPerToken: 0.7e-6 },
};

export const QWEN_AUDIO_DEFAULT_MODEL = "qwen-audio-3.1-asr-flash-message";

export interface QwenAudioProviderConfig {
  apiKey: string;
  /** A model id from {@link QWEN_AUDIO_PRICING}. */
  model?: string;
  /** The Model Studio workspace the key belongs to; the endpoint is per workspace. */
  workspaceId?: string;
  /** Full endpoint. Overridden in tests. */
  baseUrl?: string;
  /** Overrides {@link QWEN_AUDIO_PRICING} for this model — rates are regional. */
  pricing?: QwenAudioTokenPricing;
}

/** Singapore, to match the rates in {@link QWEN_AUDIO_PRICING}. */
const WORKSPACE_REGION = "ap-southeast-1";

/** 100 ms of 16 kHz 16-bit mono — what the vendor's own samples send. */
const CHUNK_SIZE = 3200;

/** The workspace endpoint, or `baseUrl` where a test has pointed it elsewhere. */
export function resolveQwenAudioUrl(config: QwenAudioProviderConfig): string {
  if (config.baseUrl) return config.baseUrl;
  if (!config.workspaceId) {
    throw new Error("Qwen Audio is served from a workspace endpoint: set DASHSCOPE_WORKSPACE_ID");
  }
  if (!isValidWorkspaceId(config.workspaceId)) {
    // Not echoed: it is a malformed value, and may be a secret typed in the wrong place.
    throw new Error("DASHSCOPE_WORKSPACE_ID must be letters, digits and hyphens only");
  }
  return `wss://${config.workspaceId}.${WORKSPACE_REGION}.maas.aliyuncs.com/api-ws/v1/inference`;
}

/**
 * Join finished sentences. The vendor ends a sentence on a silence, and Thai
 * has no inter-word spaces, so a space is only added between two Latin runs.
 */
function joinSentences(parts: readonly string[]): string {
  let out = "";
  for (const part of parts) {
    if (!part) continue;
    out += out && /[\x21-\x7e]$/.test(out) && /^[\x21-\x7e]/.test(part) ? ` ${part}` : part;
  }
  return out;
}

interface ServerFrame {
  header?: {
    event?: string;
    error_code?: string;
    error_message?: string;
  };
  payload?: {
    output?: {
      sentence?: {
        sentence_id?: number;
        sentence_end?: boolean;
        heartbeat?: boolean;
        text?: string;
      };
    };
    usage?: { input_tokens?: number; output_tokens?: number };
  };
}

export function createQwenAudioProvider(config: QwenAudioProviderConfig): ASRProvider {
  const model = config.model ?? QWEN_AUDIO_DEFAULT_MODEL;
  const pricing = config.pricing ?? QWEN_AUDIO_PRICING[model];
  if (!pricing) {
    // The registry allowlists models before we are reached, so a model with no
    // rates is a programming error. Charging $0 silently would be worse.
    throw new Error(
      `No pricing for Qwen Audio model "${model}" (known: ${Object.keys(QWEN_AUDIO_PRICING).join(", ")})`,
    );
  }
  const url = resolveQwenAudioUrl(config);

  return {
    createSession(callbacks: ASRCreateSessionOptions): ASRSession {
      const ws = new WebSocket(url, {
        headers: { Authorization: `bearer ${config.apiKey}` },
      });
      const taskId = randomUUID().replaceAll("-", "");

      let started = false;
      let endRequested = false;
      let held: Buffer[] = [];
      // Every sentence seen, finished or not, by id. A sentence that never gets
      // `sentence_end` (the task finishing first) still counts: dropping it would
      // lose the tail of what was said.
      const sentences = new Map<number, string>();
      let lastUsage: { input_tokens?: number; output_tokens?: number } | undefined;
      // `task-finished` / `task-failed` / an unexpected close each end the
      // session exactly once; anything after is ignored.
      let done = false;

      const send = (frame: object) => ws.send(JSON.stringify(frame));
      const sendFinish = () =>
        send({
          header: { action: "finish-task", task_id: taskId, streaming: "duplex" },
          payload: { input: {} },
        });

      function transcript(): string {
        return joinSentences(
          [...sentences.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text),
        );
      }

      /** Report a failure once, with the workspace id taken out of it. */
      function fail(error: Error) {
        if (done) return;
        done = true;
        callbacks.onError?.(new Error(redactWorkspaceId(error.message, config.workspaceId)));
        ws.close();
      }

      function reportUsage(usage = lastUsage): UsageRecord[] {
        if (!usage) return [];
        return [
          {
            sku: `dashscope:${model}:input-tokens`,
            unitPrice: pricing!.inputPerToken,
            quantity: usage.input_tokens ?? 0,
          },
          {
            sku: `dashscope:${model}:output-tokens`,
            unitPrice: pricing!.outputPerToken,
            quantity: usage.output_tokens ?? 0,
          },
        ];
      }

      let abandoned = false;
      const session = createBufferedSocketSession({
        ws,
        chunkSize: CHUNK_SIZE,
        sendHandshake() {
          send({
            header: { action: "run-task", task_id: taskId, streaming: "duplex" },
            payload: {
              task_group: "audio",
              task: "asr",
              function: "recognition",
              model,
              parameters: {
                format: "pcm",
                sample_rate: 16000,
                // The streaming model sends partials by default; the message
                // model sends only finals unless asked.
                intermediate_result_enabled: true,
              },
              input: {},
            },
          });
        },
        sendChunk(chunk) {
          if (started) ws.send(chunk);
          else held.push(Buffer.from(chunk));
        },
        endTurn(remaining) {
          if (remaining.length > 0) {
            if (started) ws.send(remaining);
            else held.push(Buffer.from(remaining));
          }
          endRequested = true;
          if (started) sendFinish();
        },
        handleMessage(raw) {
          let frame: ServerFrame;
          try {
            frame = JSON.parse(raw.toString("utf8"));
          } catch {
            return;
          }
          if (done) return;
          switch (frame.header?.event) {
            case "task-started": {
              if (started) return;
              started = true;
              for (const chunk of held) ws.send(chunk);
              held = [];
              if (endRequested) sendFinish();
              return;
            }
            case "result-generated": {
              const sentence = frame.payload?.output?.sentence;
              if (frame.payload?.usage) lastUsage = frame.payload.usage;
              if (!sentence || sentence.heartbeat) return;
              const id = sentence.sentence_id ?? 0;
              const text = sentence.text ?? "";
              // An empty frame never erases text already seen for the sentence.
              if (text || !sentences.has(id)) sentences.set(id, text);
              if (!sentence.sentence_end && text) callbacks.onPartial?.(transcript());
              return;
            }
            case "task-finished": {
              done = true;
              const usage = frame.payload?.usage ?? lastUsage;
              const text = transcript();
              if (text.trim()) callbacks.onFinal?.(text);
              callbacks.onUsage?.(reportUsage(usage));
              callbacks.onEnd?.();
              ws.close(1000, "done");
              return;
            }
            case "task-failed": {
              fail(
                new Error(
                  `Qwen Audio ${frame.header?.error_code ?? "error"}: ${frame.header?.error_message ?? "task failed"}`,
                ),
              );
              return;
            }
          }
        },
        onError(err) {
          fail(err);
        },
      });

      // The vendor can drop the socket without ever sending `task-finished` or
      // `task-failed` (an idle timeout, a server restart). Without this the
      // session would wait for an end that is not coming.
      ws.on("close", () => {
        if (!abandoned) fail(new Error("Qwen Audio connection closed before the task finished"));
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
