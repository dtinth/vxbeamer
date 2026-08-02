import WebSocket from "ws";
import type { ASRCreateSessionOptions, ASRProvider, ASRSession, UsageRecord } from "../asr.ts";
import { createBufferedSocketSession } from "./bufferedSocketSession.ts";

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

/** Default {@link QwenOmniProviderConfig.stickyLingerMs}. */
export const DEFAULT_STICKY_LINGER_MS = 30_000;
/** Default {@link QwenOmniProviderConfig.stickyMaxAudioSeconds}. */
export const DEFAULT_STICKY_MAX_AUDIO_SECONDS = 180;

export interface QwenOmniProviderConfig {
  apiKey: string;
  /** A model id from {@link QWEN_OMNI_PRICING}. */
  model?: string;
  /** Endpoint, without the `?model=` query. Overridden in tests. */
  baseUrl?: string;
  /** Overrides {@link QWEN_OMNI_PRICING} for this model — rates are regional. */
  pricing?: QwenOmniTokenPricing;
  /**
   * How long a connection lingers, unused, after a turn ends before it is
   * really closed — see {@link ASRCreateSessionOptions.clientId}. Default
   * {@link DEFAULT_STICKY_LINGER_MS}.
   */
  stickyLingerMs?: number;
  /**
   * Total input audio a lingering connection may carry across turns before it
   * is retired instead of offered for reuse — bounds token cost and context
   * growth, since the vendor re-processes prior turns as context on every new
   * one. Checked once a turn completes, not mid-turn: a turn that pushes past
   * this is still allowed to finish normally. Default
   * {@link DEFAULT_STICKY_MAX_AUDIO_SECONDS}.
   */
  stickyMaxAudioSeconds?: number;
}

const DEFAULT_BASE_URL = "wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime";

/** 16 kHz 16-bit mono — matches {@link CHUNK_SIZE}'s own unit. */
const BYTES_PER_SECOND = 32_000;

interface StickyConnection {
  readonly ws: WebSocket;
  /**
   * The model this connection is open for. A later turn requesting a
   * different model (e.g. the operator changed `ASR_MODEL`) must not reuse
   * it — the vendor connection is pinned to whatever model it opened with.
   */
  readonly model: string;
  /** Input audio this connection has carried across all its turns so far. */
  totalAudioSeconds: number;
  /** True while a turn is actively using this connection. */
  busy: boolean;
  /** Armed once idle; retires the connection if nothing claims it in time. */
  lingerTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Lingering vendor connections, keyed by {@link ASRCreateSessionOptions.clientId}.
 *
 * Module-level rather than closed over inside {@link createQwenOmniProvider}:
 * the provider registry resolves a fresh provider instance per `/ws`
 * connection (`ProviderSpec.create` runs once per `resolve()` call — see
 * `../registry.ts`), so anything meant to survive across connections has to
 * live above that, for the lifetime of the process.
 */
const stickyPool = new Map<string, StickyConnection>();

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
  const lingerMs = config.stickyLingerMs ?? DEFAULT_STICKY_LINGER_MS;
  const maxAudioSeconds = config.stickyMaxAudioSeconds ?? DEFAULT_STICKY_MAX_AUDIO_SECONDS;

  return {
    createSession(options: ASRCreateSessionOptions): ASRSession {
      const { clientId } = options;
      const existing = clientId ? stickyPool.get(clientId) : undefined;
      const reusing = !!(
        existing &&
        !existing.busy &&
        existing.model === model &&
        existing.ws.readyState === WebSocket.OPEN
      );

      let startingAudioSeconds = 0;
      if (reusing && existing) {
        startingAudioSeconds = existing.totalAudioSeconds;
        existing.busy = true;
        if (existing.lingerTimer) {
          clearTimeout(existing.lingerTimer);
          existing.lingerTimer = null;
        }
      } else if (existing && clientId && existing.ws.readyState !== WebSocket.OPEN) {
        // A dead socket cannot serve this turn — drop it so it doesn't
        // shadow whatever gets pooled next. A *busy* entry, or one pinned to
        // a different model, is left alone; its own turn still owns it.
        stickyPool.delete(clientId);
      }

      const ws =
        reusing && existing
          ? existing.ws
          : new WebSocket(url, {
              headers: {
                Authorization: `Bearer ${config.apiKey}`,
                "OpenAI-Beta": "realtime=v1",
              },
            });

      let transcript = "";
      // Total bytes appended this turn — the ASR providers deliberately skip
      // byte accounting (they bill per audio-second, not per token), but this
      // one needs it regardless of billing: it bounds context growth, not
      // cost (see {@link settle}).
      let turnBytesSent = 0;

      const append = (audio: Buffer) => {
        turnBytesSent += audio.length;
        ws.send(
          JSON.stringify({
            event_id: `event_${Date.now()}`,
            type: "input_audio_buffer.append",
            audio: audio.toString("base64"),
          }),
        );
      };

      function sendHandshake() {
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
              // streams events we would only ignore, for a second model's
              // worth of audio we never asked to be heard by. Verified: `{}`
              // yields zero `conversation.item.input_audio_transcription.*`
              // events.
              input_audio_transcription: {},
            },
          }),
        );
      }

      // Ends the turn. Unlike the ASR protocol, committing the buffer only
      // closes the *input*: the model does nothing until `response.create`
      // asks it for one. There is no `session.finish` here.
      function endTurn(remaining: Buffer) {
        if (remaining.length > 0) append(remaining);
        ws.send(JSON.stringify({ event_id: "event_commit", type: "input_audio_buffer.commit" }));
        ws.send(JSON.stringify({ event_id: "event_response", type: "response.create" }));
      }

      /**
       * Offers this connection back to the pool once its turn ends cleanly,
       * unless there is no client id (today's plain behaviour), it would
       * cross {@link maxAudioSeconds}, or another turn has since claimed the
       * one pool slot for this client id — in any of those cases it is
       * retired instead.
       */
      function settle() {
        if (!clientId) {
          ws.close(1000, "done");
          return;
        }
        const current = stickyPool.get(clientId);
        if (current && current.ws !== ws) {
          ws.close(1000, "done");
          return;
        }
        const totalAudioSeconds = startingAudioSeconds + turnBytesSent / BYTES_PER_SECOND;
        if (totalAudioSeconds >= maxAudioSeconds) {
          stickyPool.delete(clientId);
          ws.close(1000, "done");
          return;
        }
        // Release this turn's own message/error handlers now rather than
        // keeping them (and everything they close over — a whole backend
        // request's worth of state) reachable for the rest of the linger
        // window. A lone `error` handler replaces them: an EventEmitter with
        // no `error` listener throws on one, and this connection may now sit
        // idle for a while before the next turn (or the linger timeout)
        // attaches a real handler.
        ws.removeAllListeners("message");
        ws.removeAllListeners("error");
        ws.on("error", () => {
          if (stickyPool.get(clientId)?.ws === ws) stickyPool.delete(clientId);
          ws.close();
        });
        const entry: StickyConnection = {
          ws,
          model,
          totalAudioSeconds,
          busy: false,
          lingerTimer: null,
        };
        entry.lingerTimer = setTimeout(() => {
          if (stickyPool.get(clientId) === entry) {
            stickyPool.delete(clientId);
            ws.close(1000, "linger timeout");
          }
        }, lingerMs);
        stickyPool.set(clientId, entry);
      }

      /** Drops this connection from the pool without pretending it is still good. */
      function evict() {
        if (clientId && stickyPool.get(clientId)?.ws === ws) stickyPool.delete(clientId);
      }

      function handleMessage(raw: Buffer) {
        const data = JSON.parse(raw.toString());

        if (data.type === "response.text.delta") {
          // Deltas are incremental, so the running text is what a partial is.
          transcript += data.delta ?? "";
          options.onPartial?.(transcript);
        } else if (data.type === "response.text.done") {
          transcript = data.text ?? transcript;
          options.onFinal?.(transcript);
        } else if (data.type === "response.done") {
          // Usage lands here, after the text — so this, not
          // `response.text.done`, is where a session ends.
          options.onUsage?.(buildUsageRecords(model, pricing, data.response?.usage));
          options.onEnd?.();
          settle();
        } else if (data.type === "error") {
          options.onError?.(new Error(JSON.stringify(data)));
          // The turn is over and will produce nothing, so hang up rather than
          // hold the socket open (and never offer a connection that just
          // misbehaved back for reuse). A session that has errored still
          // counts against the vendor's 120-minute session cap until it closes.
          evict();
          ws.close();
        }
      }

      // A reused connection is already open and configured from an earlier
      // turn — `alreadyOpen` skips resending the handshake and waiting for an
      // `open` event that will never fire again on it.
      return createBufferedSocketSession({
        ws,
        chunkSize: CHUNK_SIZE,
        sendChunk: append,
        sendHandshake,
        endTurn,
        handleMessage,
        alreadyOpen: reusing,
        onError(err) {
          options.onError?.(err);
          evict();
        },
      });
    },
  };
}
