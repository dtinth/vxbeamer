import WebSocket from "ws";
import { randomUUID } from "crypto";
import type { ASRProvider, ASRSession, ASRSessionCallbacks } from "../asr.ts";

export interface BytePlusProviderConfig {
  apiKey: string;
  resourceId?: string;
  url?: string;
}

const CHUNK_SIZE = 6400; // 200ms at 16kHz 16-bit mono (recommended for bi-directional)

// Header layout (4 bytes):
//   [0] version(4) | header_size(4)   → 0x11 (v1, 4-byte header)
//   [1] msg_type(4) | flags(4)
//   [2] serialization(4) | compression(4)
//   [3] reserved 0x00

function buildFullClientRequest(payload: object): Buffer {
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.from([0x11, 0x10, 0x10, 0x00]);
  const size = Buffer.allocUnsafe(4);
  size.writeUInt32BE(json.length, 0);
  return Buffer.concat([header, size, json]);
}

function buildAudioPacket(audio: Buffer, isLast: boolean): Buffer {
  const header = Buffer.from([0x11, isLast ? 0x22 : 0x20, 0x00, 0x00]);
  const size = Buffer.allocUnsafe(4);
  size.writeUInt32BE(audio.length, 0);
  return Buffer.concat([header, size, audio]);
}

function parseServerMessage(data: Buffer): { isLast: boolean; text: string; error?: string } {
  const msgType = (data[1] >> 4) & 0xf;
  const flags = data[1] & 0xf;

  if (msgType === 0b1111) {
    const errCode = data.readUInt32BE(4);
    const errMsgSize = data.readUInt32BE(8);
    const errMsg = data.subarray(12, 12 + errMsgSize).toString("utf8");
    return { isLast: true, text: "", error: `Error ${errCode}: ${errMsg}` };
  }

  // Full server response: Header(4) | Sequence(4) | PayloadSize(4) | Payload
  const payloadSize = data.readUInt32BE(8);
  const payload = JSON.parse(data.subarray(12, 12 + payloadSize).toString("utf8"));
  const isLast = !!(flags & 0b0010) || !!payload.is_last_package;
  const text: string = payload.result?.text ?? "";

  return { isLast, text };
}

export function createBytePlusProvider(config: BytePlusProviderConfig): ASRProvider {
  return {
    createSession(callbacks: ASRSessionCallbacks): ASRSession {
      const ws = new WebSocket(
        config.url ?? "wss://voice.ap-southeast-1.bytepluses.com/api/v3/sauc/bigmodel",
        {
          headers: {
            "X-Api-Key": config.apiKey,
            "X-Api-Resource-Id": config.resourceId ?? "volc.seedasr.sauc.duration",
            "X-Api-Connect-Id": randomUUID(),
          },
        },
      );

      let buffer = Buffer.alloc(0);
      let ready = false;
      let finishing = false;

      function flushBuffer() {
        while (buffer.length >= CHUNK_SIZE) {
          const chunk = buffer.subarray(0, CHUNK_SIZE);
          buffer = buffer.subarray(CHUNK_SIZE);
          ws.send(buildAudioPacket(chunk, false));
        }
      }

      ws.on("open", () => {
        ws.send(
          buildFullClientRequest({
            user: { uid: "cli-user" },
            audio: { format: "pcm", codec: "raw", rate: 16000, bits: 16, channel: 1 },
            request: { model_name: "bigmodel", enable_itn: true, enable_punc: true },
          }),
        );
        ready = true;
        flushBuffer();
      });

      ws.on("message", (raw: Buffer) => {
        const { isLast, text, error } = parseServerMessage(raw as Buffer);

        if (error) {
          callbacks.onError?.(new Error(error));
          ws.close();
          return;
        }

        if (isLast) {
          if (text.trim()) callbacks.onFinal?.(text);
          callbacks.onEnd?.();
          ws.close(1000, "done");
        } else if (text) {
          callbacks.onPartial?.(text);
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
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.send(buildAudioPacket(buffer, true));
          buffer = Buffer.alloc(0);
        },
      };
    },
  };
}
