import WebSocket from "ws";
import type { ASRCreateSessionOptions, ASRProvider, ASRSession } from "../asr.ts";
import { createBufferedSocketSession } from "./bufferedSocketSession.ts";
import { PAXA_USD_PER_CREDIT } from "./paxa.ts";

/**
 * Paxa Labs' realtime speech-to-text WebSocket
 * (https://paxalabs.com/docs/speech-to-text), the streaming sibling of the
 * batch endpoint in `./paxa.ts`. Tried live on `testdata/test-audio.bin`
 * before this was written (dtinth/vxbeamer#86):
 *
 * - Auth is an `Authorization: Bearer` header on the upgrade request; a wrong
 *   key is refused with HTTP 401 before the socket opens.
 * - A `start` JSON frame, then raw binary PCM frames, then `{"type":"end"}`.
 *   Audio sent before the server's `started` reply is accepted, and 100 ms
 *   frames work as well as the 20 ms frames the docs show.
 * - **The server detects turns itself.** A pause in the speech ends a turn,
 *   and each turn gets its own final `transcript`. This session gives one
 *   final per recording, so the turns are joined here: a partial is the
 *   finished turns plus the current turn's partial, and the final is all the
 *   finished turns, sent once `done` arrives. Without this, a pause would
 *   drop everything said before it.
 * - `done` always arrives after `end`, even for silence (`turns: 0`), so it is
 *   the one place the session ends.
 * - Per-turn failures arrive as `{"type":"error","turn":N}` with no message.
 *   Reported rather than skipped: skipping would lose that turn's speech
 *   with no sign to the user.
 *
 * Faster than realtime is accepted: a whole 9.2 s clip sent at once came back
 * in 0.7 s, with the same transcript.
 */
export interface PaxaRealtimeProviderConfig {
  apiKey: string;
  model?: string;
  /** As for the batch endpoint — see `PaxaProviderConfig.convention` in `./paxa.ts`. */
  convention?: "spoken" | "written";
  /** Endpoint. Overridden in tests. */
  baseUrl?: string;
}

const DEFAULT_BASE_URL = "wss://api.paxalabs.com/v1/stt/live";

export const PAXA_REALTIME_DEFAULT_MODEL = "paxa-stt-lite-realtime-v1-preview";

const CHUNK_SIZE = 3200; // 100 ms at 16 kHz 16-bit mono

/**
 * 12.5 credits per minute, against 8.33 for batch. The whole connection is
 * charged, silence included, which `done.total_seconds` reports. The vendor
 * also has a 0.1-credit minimum per connection, which only matters below
 * half a second, and is not modelled.
 */
const PAXA_REALTIME_CREDITS_PER_SECOND = 12.5 / 60;

export function createPaxaRealtimeProvider(config: PaxaRealtimeProviderConfig): ASRProvider {
  const model = config.model ?? PAXA_REALTIME_DEFAULT_MODEL;

  return {
    createSession(callbacks: ASRCreateSessionOptions): ASRSession {
      const ws = new WebSocket(config.baseUrl ?? DEFAULT_BASE_URL, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
      });

      const finishedTurns: string[] = [];
      const joined = (...more: string[]) =>
        [...finishedTurns, ...more].filter((text) => text.length > 0).join(" ");
      let ended = false;

      const end = (error?: Error) => {
        if (ended) return;
        ended = true;
        if (error) callbacks.onError?.(error);
        ws.close(1000, "done");
      };

      const session = createBufferedSocketSession({
        ws,
        chunkSize: CHUNK_SIZE,
        sendChunk(chunk) {
          ws.send(chunk);
        },
        sendHandshake() {
          ws.send(
            JSON.stringify({
              type: "start",
              model,
              audio: { encoding: "pcm_s16le", sample_rate: 16000 },
              ...(config.convention ? { convention: config.convention } : {}),
            }),
          );
        },
        endTurn(remaining) {
          if (remaining.length > 0) ws.send(remaining);
          ws.send(JSON.stringify({ type: "end" }));
        },
        handleMessage(raw) {
          if (ended) return;
          const data = JSON.parse(raw.toString());

          if (data.type === "transcript") {
            const text: string = data.text ?? "";
            if (data.is_final) {
              finishedTurns.push(text);
              callbacks.onPartial?.(joined());
            } else {
              callbacks.onPartial?.(joined(text));
            }
          } else if (data.type === "done") {
            callbacks.onFinal?.(joined());
            const seconds = data.total_seconds;
            if (typeof seconds === "number" && seconds > 0) {
              callbacks.onUsage?.([
                {
                  sku: `paxa:${model}:seconds`,
                  unitPrice: PAXA_REALTIME_CREDITS_PER_SECOND * PAXA_USD_PER_CREDIT,
                  quantity: seconds,
                },
              ]);
            }
            callbacks.onEnd?.();
            end();
          } else if (data.type === "error") {
            end(new Error(`Paxa realtime: turn ${data.turn ?? "?"} failed: ${raw.toString()}`));
          }
          // `started`, `speech_started`, `speech_ended` and `charged` need no
          // action: the transcripts and `done` carry everything used here.
        },
        onError(err) {
          end(err);
        },
      });

      // The server closing before `done` (it never should) would otherwise
      // leave the caller waiting for an end that never comes.
      ws.on("close", (code, reason) => {
        if (!ended)
          end(new Error(`Paxa realtime closed before done: ${code} ${reason.toString()}`));
      });

      return {
        sendAudio: (chunk) => session.sendAudio(chunk),
        finish: () => session.finish(),
        close() {
          // The caller hung up: nothing more is reported, not even the close.
          ended = true;
          session.close();
        },
      };
    },
  };
}
