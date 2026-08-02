import WebSocket from "ws";
import { randomUUID } from "crypto";
import type { ASRCreateSessionOptions, ASRProvider, ASRSession } from "../asr.ts";
import { BYTES_PER_SECOND } from "../audio.ts";
import { createBufferedSocketSession } from "./bufferedSocketSession.ts";

const BYTEPLUS_PRICE_PER_SECOND = 0.15 / 3600;

export interface BytePlusProviderConfig {
  apiKey: string;
  /** A mode id from {@link BYTEPLUS_MODES}. Defaults to `bigmodel_nostream`. */
  model?: string;
  /**
   * BCP-47 language hint, e.g. `th-TH`. Honoured only by modes that declare
   * `supportsLanguage`; silently dropped elsewhere, because the vendor does not
   * accept the field there at all.
   */
  language?: string;
  resourceId?: string;
  /** Endpoint base, without the mode's path segment. Overridden in tests. */
  baseUrl?: string;
}

const DEFAULT_BASE_URL = "wss://voice.ap-southeast-1.bytepluses.com/api/v3/sauc";

/**
 * What BytePlus calls a *mode* is a distinct endpoint path, and the modes are
 * not interchangeable — they differ in what they can transcribe at all.
 *
 * `bigmodel` is the bi-directional streaming mode. It does not accept a
 * `language` field ("Only for streaming input mode /api/v3/sauc/bigmodel_nostream,
 * not for bi-directional streaming mode"), and with no language it covers only
 * "Mandarin Chinese, English, Cantonese, Shanghainese, Minnan, Sichuan, Shaanxi
 * dialect". Thai is not reachable from it — on Thai speech it returns confident
 * nonsense in English and Chinese rather than failing.
 *
 * `bigmodel_nostream` is the streaming-input mode. It takes `language`, and with
 * `th-TH` it returns correct Thai. The trade is latency: the vendor returns
 * results "after the input audio exceeds 15 seconds, or after the final packet",
 * so a clip shorter than 15 s yields no partials at all — it is accuracy-tuned,
 * not low-latency.
 *
 * `model_name` stays `bigmodel` for both: that is the vendor's name for the
 * *model*, and it distinguishes the two *modes* by path alone.
 */
export interface BytePlusMode {
  /** Final path segment of the endpoint. */
  readonly path: string;
  /** Value of `request.model_name` on the wire. */
  readonly modelName: string;
  /** Whether this mode accepts `audio.language`. */
  readonly supportsLanguage: boolean;
}

export const BYTEPLUS_MODES: Readonly<Record<string, BytePlusMode>> = {
  bigmodel_nostream: {
    path: "bigmodel_nostream",
    modelName: "bigmodel",
    supportsLanguage: true,
  },
  bigmodel: {
    path: "bigmodel",
    modelName: "bigmodel",
    supportsLanguage: false,
  },
};

export const BYTEPLUS_DEFAULT_MODE = "bigmodel_nostream";

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
  const modeId = config.model ?? BYTEPLUS_DEFAULT_MODE;
  const mode = BYTEPLUS_MODES[modeId];
  if (!mode) {
    // The registry allowlists models before we are reached, so this is a
    // programming error rather than a request failure.
    throw new Error(
      `Unknown BytePlus mode "${modeId}" (known: ${Object.keys(BYTEPLUS_MODES).join(", ")})`,
    );
  }

  const base = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const url = `${base}/${mode.path}`;

  return {
    createSession(callbacks: ASRCreateSessionOptions): ASRSession {
      const ws = new WebSocket(url, {
        headers: {
          "X-Api-Key": config.apiKey,
          "X-Api-Resource-Id": config.resourceId ?? "volc.seedasr.sauc.duration",
          "X-Api-Connect-Id": randomUUID(),
        },
      });

      let totalBytesSent = 0;

      return createBufferedSocketSession({
        ws,
        chunkSize: CHUNK_SIZE,
        sendChunk(chunk) {
          totalBytesSent += chunk.length;
          ws.send(buildAudioPacket(chunk, false));
        },
        sendHandshake() {
          ws.send(
            buildFullClientRequest({
              user: { uid: "cli-user" },
              audio: {
                format: "pcm",
                codec: "raw",
                rate: 16000,
                bits: 16,
                channel: 1,
                // `language` belongs to the audio object, not the request
                // object, and only where the mode declares it — the vendor
                // documents it as unsupported on bi-directional streaming.
                ...(mode.supportsLanguage && config.language ? { language: config.language } : {}),
              },
              request: {
                model_name: mode.modelName,
                enable_itn: true,
                enable_punc: true,
              },
            }),
          );
        },
        // BytePlus ends the turn with a final audio packet, so this is sent even
        // when `remaining` is empty: the `isLast` flag is what closes the turn.
        endTurn(remaining) {
          totalBytesSent += remaining.length;
          ws.send(buildAudioPacket(remaining, true));
        },
        handleMessage(raw) {
          const { isLast, text, error } = parseServerMessage(raw);

          if (error) {
            callbacks.onError?.(new Error(error));
            ws.close();
            return;
          }

          if (isLast) {
            if (text.trim()) callbacks.onFinal?.(text);
            const seconds = Math.ceil(totalBytesSent / BYTES_PER_SECOND);
            callbacks.onUsage?.([
              {
                sku: "byteplus:seedasr:seconds",
                unitPrice: BYTEPLUS_PRICE_PER_SECOND,
                quantity: seconds,
              },
            ]);
            callbacks.onEnd?.();
            ws.close(1000, "done");
          } else if (text) {
            callbacks.onPartial?.(text);
          }
        },
        onError(err) {
          callbacks.onError?.(err);
        },
      });
    },
  };
}
