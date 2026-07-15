import type { WSContext, WSMessageReceive } from "hono/ws";
import type { ASRSession, UsageRecord } from "vxasr";
import type { ConfigurationSelector } from "./asr.ts";
import { normalizeTranscriptText } from "./transcript.ts";

/**
 * The eval replay socket: transcription with no message log behind it.
 *
 * `/ws` and this route ask the same question of the same catalogue — "transcribe
 * this PCM with configuration X" — and differ in exactly one way: `/ws` writes
 * what it hears into the caller's message log, and this does not. The eval
 * fan-out (dtinth/vxbeamer#38) decided that an eval run creates no message, and
 * decided it as a *route* rather than a flag, so the guarantee is structural.
 *
 * This module is the structure: it does not import `./store.ts`, so there is no
 * `addMessage` or `broadcast` in scope here to call by accident. The guarantee
 * holds by what this file can reach, not by a branch someone has to remember.
 *
 * The consequence is that results have nowhere to go except back down the same
 * socket — the frontend is the only place an eval run exists. So unlike `/ws`,
 * whose client never reads a frame (transcripts arrive over SSE), this speaks
 * {@link EvalServerEvent} to its caller.
 */

/** Server -> client. Text frames; the client's PCM goes the other way as binary. */
export type EvalServerEvent =
  /** The vendor session is live and pacing can begin. */
  | { type: "ready"; configurationId: string }
  | { type: "partial"; text: string }
  | { type: "final"; text: string }
  | { type: "usage"; records: readonly UsageRecord[] }
  | { type: "end" }
  /**
   * Carries a failure the close frame cannot: a close reason is capped at 123
   * bytes, and a vendor error is often longer and is the whole diagnosis.
   */
  | { type: "error"; message: string };

export interface EvalSocketOptions {
  /** Only `select` — nothing here has any business listing or enabling. */
  selector: Pick<ConfigurationSelector, "select">;
  /** The `?configuration=` query param, if the client sent a non-empty one. */
  configuration: string | undefined;
}

/**
 * A `hono/ws` handler set. Structurally typed rather than imported as `WSEvents`
 * so this module stays testable without standing up a Hono app.
 */
export interface EvalSocketHandler {
  onOpen(evt: Event, ws: WSContext): void;
  onMessage(evt: MessageEvent<WSMessageReceive>, ws: WSContext): void;
  onClose(): void;
}

export function createEvalSocketHandler(options: EvalSocketOptions): EvalSocketHandler {
  let session: ASRSession | null = null;
  let finished = false;
  let closed = false;

  const send = (ws: WSContext, event: EvalServerEvent): void => {
    if (closed) return;
    ws.send(JSON.stringify(event));
  };

  const close = (ws: WSContext, code: number, reason: string): void => {
    if (closed) return;
    closed = true;
    ws.close(code, reason);
  };

  return {
    onOpen(_evt: Event, ws: WSContext) {
      const result = options.selector.select({ configuration: options.configuration });
      if (!result.ok) {
        // Same codes the recording socket uses for the same two situations:
        // 1011 when the server is missing credentials, 1008 when the client
        // named something this server will not serve. The selector has already
        // clamped the message to a legal close reason.
        close(ws, result.code === "not_configured" ? 1011 : 1008, result.message);
        return;
      }

      const { provider, configurationId } = result.selection;
      session = provider.createSession({
        onUsage(records) {
          // Cost is an eval axis alongside accuracy (#38), and the dialog is the
          // only thing that will ever see these — nothing here records them.
          send(ws, { type: "usage", records });
        },
        onPartial(text) {
          send(ws, { type: "partial", text: normalizeTranscriptText(text) });
        },
        onFinal(text) {
          send(ws, { type: "final", text: normalizeTranscriptText(text) });
        },
        onEnd() {
          send(ws, { type: "end" });
          close(ws, 1000, "done");
        },
        onError(err) {
          send(ws, { type: "error", message: err instanceof Error ? err.message : String(err) });
          close(ws, 1011, "ASR error");
        },
      });

      // Announced only once the vendor session exists, so a client that waits
      // for it is not pacing 100 ms frames into a socket about to close.
      send(ws, { type: "ready", configurationId });
    },

    onMessage(evt: MessageEvent<WSMessageReceive>) {
      const { data } = evt;
      if (data instanceof ArrayBuffer) {
        session?.sendAudio(Buffer.from(data));
      } else if (ArrayBuffer.isView(data)) {
        session?.sendAudio(
          Buffer.from(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength),
        );
      } else if (typeof data === "string") {
        try {
          const message = JSON.parse(data) as { type?: string };
          if (message.type === "stop" && !finished) {
            finished = true;
            session?.finish();
          }
        } catch {
          // ignore invalid messages
        }
      }
    },

    onClose() {
      closed = true;
      if (!finished) {
        finished = true;
        session?.finish();
      }
    },
  };
}
