import WebSocket from "ws";
import type { ASRCreateSessionOptions, ASRProvider, ASRSession } from "../asr.ts";
import { BYTES_PER_SECOND } from "../audio.ts";
import { createBufferedSocketSession } from "./bufferedSocketSession.ts";

/**
 * ElevenLabs Scribe Realtime v2, over its realtime speech-to-text WebSocket
 * (`wss://api.elevenlabs.io/v1/speech-to-text/realtime`).
 *
 * The wire, as confirmed live (testdata/OBSERVATIONS.md, "Scribe Realtime v2"):
 *
 * - Configuration is in the query string. The server speaks first with
 *   `session_started`; audio is held until it arrives.
 * - Audio is JSON: `{"message_type":"input_audio_chunk","audio_base_64":…,
 *   "commit":false,"sample_rate":16000}`. The turn ends with an empty chunk and
 *   `commit: true`.
 * - `partial_transcript` is the running text of the segment being heard (each
 *   replaces the one before); `committed_transcript` is that segment's final
 *   text. The vendor commits by itself after about 36 s of audio, so a long
 *   recording yields several committed segments, and the one that answers *our*
 *   commit is the last. Nothing on the wire says which is which, and with
 *   audio sent faster than real time an automatic commit can arrive *after* our
 *   own commit was sent, so a recording long enough for one to have happened
 *   waits for the segments to stop arriving (see {@link AUTO_COMMIT_SETTLE_MS}).
 * - A commit with under 0.3 s of uncommitted audio is refused (`commit_throttled`)
 *   and the socket closed, so a very short recording is padded with silence.
 * - Errors arrive as `{"message_type":"<kind>","error":"<text>"}` and then the
 *   socket closes.
 *
 * It accepts audio faster than real time (a 9.2 s clip all at once finished in
 * about 1.6 s with the same text), so this is declared fast-dump capable.
 *
 * Billed per hour of audio: $0.22.
 */

/** USD per second: $0.22 per hour of audio (the vendor's pricing page, 2026-11-14). */
export const ELEVENLABS_PRICE_PER_SECOND = 0.22 / 3600;

export const ELEVENLABS_DEFAULT_MODEL = "scribe_v2_realtime";

/** 100 ms of 16 kHz 16-bit mono. The vendor's docs use 1 s; 100 ms works and keeps partials responsive. */
const CHUNK_SIZE = 3200;

/** The vendor refuses a commit with less uncommitted audio than this. */
const MIN_COMMIT_BYTES = Math.ceil(0.3 * BYTES_PER_SECOND);

/**
 * The vendor's automatic commit comes "after approximately 36 seconds" of
 * audio; at or under this much, none can have happened, and the first committed
 * segment after our commit is the answer to it.
 */
const AUTO_COMMIT_SAFE_SECONDS = 30;

/**
 * For a longer recording: how long after the latest committed segment to wait
 * for another before taking the session as finished. Adds this much latency to
 * recordings over {@link AUTO_COMMIT_SAFE_SECONDS}, and only those.
 */
export const AUTO_COMMIT_SETTLE_MS = 1000;

const DEFAULT_BASE_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";

export interface ElevenLabsProviderConfig {
  apiKey: string;
  model?: string;
  /** Endpoint, without the query string. Overridden in tests. */
  baseUrl?: string;
  /** USD per second of audio. Overrides {@link ELEVENLABS_PRICE_PER_SECOND}. */
  pricePerSecond?: number;
  /**
   * The vendor's `no_verbatim`: leave out fillers such as "um" and "uh". It
   * removed them in 2 of 2 synthetic English runs; untested on real speech.
   * Default **false**, the vendor's.
   */
  noVerbatim?: boolean;
  /** Overrides {@link AUTO_COMMIT_SETTLE_MS}. */
  settleMs?: number;
}

/**
 * Join two segments the vendor cut apart. Thai has no inter-word spaces, so a
 * space goes in only where a Latin letter or digit meets something that is not
 * already a space.
 */
function join(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  const latin = /[A-Za-z0-9]/;
  const edge = latin.test(a.at(-1)!) || latin.test(b[0]!);
  return edge && !/\s/.test(a.at(-1)!) && !/\s/.test(b[0]!) ? `${a} ${b}` : a + b;
}

/** Every `message_type` the vendor documents as an error. */
const ERROR_TYPES = new Set([
  "auth_error",
  "quota_exceeded",
  "transcriber_error",
  "input_error",
  "invalid_request",
  "error",
  "commit_throttled",
  "unaccepted_terms",
  "rate_limited",
  "queue_overflow",
  "resource_exhausted",
  "session_time_limit_exceeded",
  "chunk_size_exceeded",
  "insufficient_audio_activity",
]);

interface ServerEvent {
  message_type?: string;
  text?: string;
  error?: string;
}

export function createElevenLabsProvider(config: ElevenLabsProviderConfig): ASRProvider {
  const model = config.model ?? ELEVENLABS_DEFAULT_MODEL;
  const pricePerSecond = config.pricePerSecond ?? ELEVENLABS_PRICE_PER_SECOND;
  const query = new URLSearchParams({
    model_id: model,
    audio_format: "pcm_16000",
    commit_strategy: "manual",
  });
  if (config.noVerbatim) query.set("no_verbatim", "true");
  const url = `${config.baseUrl ?? DEFAULT_BASE_URL}?${query}`;

  return {
    createSession(callbacks: ASRCreateSessionOptions): ASRSession {
      const ws = new WebSocket(url, { headers: { "xi-api-key": config.apiKey } });

      let started = false;
      let endRequested = false;
      let commitSent = false;
      let held: Buffer[] = [];
      // Real audio sent, which is what is billed (and what the 0.3 s minimum
      // below is measured against: a recording near the minimum is far short of
      // the vendor's own ~36 s auto-commit, so counting the whole session is safe).
      let audioBytes = 0;
      // Committed segments, in order, and the running text of the one being heard.
      let segments = "";
      let interim = "";
      let done = false;
      let settleTimer: ReturnType<typeof setTimeout> | undefined;

      const sendFrame = (audio: Buffer, commit: boolean) => {
        ws.send(
          JSON.stringify({
            message_type: "input_audio_chunk",
            audio_base_64: audio.toString("base64"),
            commit,
            sample_rate: 16000,
          }),
        );
      };

      const sendAudio = (audio: Buffer) => {
        audioBytes += audio.length;
        sendFrame(audio, false);
      };

      function sendCommit() {
        commitSent = true;
        // A recording shorter than the vendor's minimum would be refused and the
        // socket closed, so top it up with silence (not counted as billed audio).
        sendFrame(Buffer.alloc(Math.max(0, MIN_COMMIT_BYTES - audioBytes)), true);
      }

      function fail(error: Error) {
        if (done) return;
        done = true;
        clearTimeout(settleTimer);
        callbacks.onError?.(error);
        ws.close();
      }

      function complete() {
        if (done) return;
        done = true;
        if (segments.trim()) callbacks.onFinal?.(segments);
        callbacks.onUsage?.([
          {
            sku: `elevenlabs:${model}:seconds`,
            unitPrice: pricePerSecond,
            quantity: audioBytes / BYTES_PER_SECOND,
          },
        ]);
        callbacks.onEnd?.();
        ws.close(1000, "done");
      }

      let abandoned = false;
      const session = createBufferedSocketSession({
        ws,
        chunkSize: CHUNK_SIZE,
        sendHandshake() {},
        sendChunk(chunk) {
          if (started) sendAudio(chunk);
          else held.push(Buffer.from(chunk));
        },
        endTurn(remaining) {
          if (remaining.length > 0) {
            if (started) sendAudio(remaining);
            else held.push(Buffer.from(remaining));
          }
          endRequested = true;
          if (started) sendCommit();
        },
        handleMessage(raw) {
          let event: ServerEvent;
          try {
            event = JSON.parse(raw.toString("utf8"));
          } catch {
            return;
          }
          if (done) return;
          const type = event.message_type;
          if (type === "session_started") {
            if (started) return;
            started = true;
            for (const chunk of held) sendAudio(chunk);
            held = [];
            if (endRequested) sendCommit();
          } else if (type === "partial_transcript") {
            interim = event.text ?? "";
            const running = join(segments, interim);
            if (running) callbacks.onPartial?.(running);
          } else if (type === "committed_transcript") {
            segments = join(segments, event.text ?? "");
            interim = "";
            // A commit the vendor made by itself (~36 s) does not end the session.
            if (!commitSent) return;
            if (audioBytes / BYTES_PER_SECOND <= AUTO_COMMIT_SAFE_SECONDS) {
              complete();
              return;
            }
            // Long enough that this may be an automatic commit's segment, with ours
            // still to come: each segment restarts the wait.
            clearTimeout(settleTimer);
            settleTimer = setTimeout(complete, config.settleMs ?? AUTO_COMMIT_SETTLE_MS);
          } else if (type && ERROR_TYPES.has(type)) {
            fail(new Error(`ElevenLabs ${type}: ${event.error ?? "no detail"}`));
          }
        },
        onError(err) {
          fail(err);
        },
      });

      // The vendor closes the socket after an error frame, and can drop it
      // without a word (an idle timeout, a restart). Without this the session
      // would wait for a transcript that is not coming.
      ws.on("close", () => {
        if (abandoned || done) return;
        // Closed while waiting for more segments: what arrived is the transcript.
        if (settleTimer) {
          clearTimeout(settleTimer);
          complete();
          return;
        }
        fail(new Error("ElevenLabs connection closed before the transcript was done"));
      });

      return {
        ...session,
        close() {
          // The caller hanging up is not a failure.
          abandoned = true;
          clearTimeout(settleTimer);
          session.close();
        },
      };
    },
  };
}
