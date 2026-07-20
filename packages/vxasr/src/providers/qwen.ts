import WebSocket from "ws";
import type { ASRProvider, ASRSession, ASRSessionCallbacks } from "../asr.ts";
import { BYTES_PER_SECOND } from "../audio.ts";
import { createBufferedSocketSession } from "./bufferedSocketSession.ts";

const QWEN_PRICE_PER_SECOND = 0.000035;

export interface QwenProviderConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

const CHUNK_SIZE = 3200; // 100ms at 16kHz 16-bit mono

export function createQwenProvider(config: QwenProviderConfig): ASRProvider {
  return {
    createSession(callbacks: ASRSessionCallbacks): ASRSession {
      const url = `${config.baseUrl ?? "wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime"}?model=${config.model ?? "qwen3-asr-flash-realtime"}`;
      const ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });

      let totalBytesSent = 0;

      const appendFrame = (audio: Buffer) =>
        ws.send(
          JSON.stringify({
            event_id: `event_${Date.now()}`,
            type: "input_audio_buffer.append",
            audio: audio.toString("base64"),
          }),
        );

      return createBufferedSocketSession({
        ws,
        chunkSize: CHUNK_SIZE,
        sendChunk(chunk) {
          totalBytesSent += chunk.length;
          appendFrame(chunk);
        },
        sendHandshake() {
          ws.send(
            JSON.stringify({
              event_id: "event_session",
              type: "session.update",
              session: {
                modalities: ["text"],
                input_audio_format: "pcm",
                sample_rate: 16000,
                input_audio_transcription: {},
                turn_detection: null,
              },
            }),
          );
        },
        endTurn(remaining) {
          if (remaining.length > 0) {
            totalBytesSent += remaining.length;
            appendFrame(remaining);
          }
          ws.send(JSON.stringify({ event_id: "event_commit", type: "input_audio_buffer.commit" }));
          ws.send(JSON.stringify({ event_id: "event_finish", type: "session.finish" }));
        },
        handleMessage(raw) {
          const data = JSON.parse(raw.toString());

          if (data.type === "conversation.item.input_audio_transcription.text") {
            callbacks.onPartial?.(data.text ?? "");
          } else if (data.type === "conversation.item.input_audio_transcription.completed") {
            callbacks.onFinal?.(data.transcript ?? "");
          } else if (data.type === "session.finished") {
            const seconds = Math.ceil(totalBytesSent / BYTES_PER_SECOND);
            callbacks.onUsage?.([
              {
                sku: "dashscope:qwen3-asr-flash:seconds",
                unitPrice: QWEN_PRICE_PER_SECOND,
                quantity: seconds,
              },
            ]);
            callbacks.onEnd?.();
            ws.close(1000, "done");
          } else if (data.type === "error") {
            callbacks.onError?.(new Error(JSON.stringify(data)));
            // The turn is over and will produce nothing, so hang up rather than
            // hold the socket open. An errored session still counts against the
            // vendor's connection cap until it closes — and "connections too
            // much" is itself one of these error frames, so leaking here
            // compounds the very condition it reports.
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
