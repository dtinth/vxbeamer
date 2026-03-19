import WebSocket from "ws";
import type { ASRProvider, ASRSession, ASRSessionCallbacks } from "../asr.ts";

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

      let buffer = Buffer.alloc(0);
      let ready = false;
      let finishing = false;

      function flushBuffer() {
        while (buffer.length >= CHUNK_SIZE) {
          const chunk = buffer.subarray(0, CHUNK_SIZE);
          buffer = buffer.subarray(CHUNK_SIZE);
          ws.send(
            JSON.stringify({
              event_id: `event_${Date.now()}`,
              type: "input_audio_buffer.append",
              audio: chunk.toString("base64"),
            }),
          );
        }
      }

      function doFinish() {
        if (buffer.length > 0) {
          ws.send(
            JSON.stringify({
              event_id: `event_${Date.now()}`,
              type: "input_audio_buffer.append",
              audio: buffer.toString("base64"),
            }),
          );
          buffer = Buffer.alloc(0);
        }
        ws.send(JSON.stringify({ event_id: "event_commit", type: "input_audio_buffer.commit" }));
        ws.send(JSON.stringify({ event_id: "event_finish", type: "session.finish" }));
      }

      ws.on("open", () => {
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
        ready = true;
        flushBuffer();
        if (finishing) doFinish();
      });

      ws.on("message", (raw: Buffer) => {
        const data = JSON.parse(raw.toString());

        if (data.type === "conversation.item.input_audio_transcription.text") {
          callbacks.onPartial?.(data.text ?? "");
        } else if (data.type === "conversation.item.input_audio_transcription.completed") {
          callbacks.onFinal?.(data.transcript ?? "");
        } else if (data.type === "session.finished") {
          callbacks.onEnd?.();
          ws.close(1000, "done");
        } else if (data.type === "error") {
          callbacks.onError?.(new Error(JSON.stringify(data)));
        }
      });

      ws.on("error", (err: Error) => callbacks.onError?.(err));

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
          // else: doFinish() will be called from the 'open' handler
        },
      };
    },
  };
}
