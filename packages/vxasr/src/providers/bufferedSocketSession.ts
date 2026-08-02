import WebSocket from "ws";
import type { ASRSession } from "../asr.ts";

/**
 * The wiring every streaming WebSocket provider repeats verbatim.
 *
 * Qwen, Qwen-Omni and BytePlus differ in what they say on the wire — URL and
 * headers, handshake, frame encoding, turn-end, how usage is measured — but the
 * *plumbing* around those is identical: buffer incoming PCM, flush it in
 * fixed-size chunks once the socket is open, hold whatever arrives before the
 * handshake, end the turn once (racing a clip that finished before the socket
 * did), tear the socket down on `close()`, and hang up on a transport error.
 * Three copies of that had already drifted apart (dtinth/vxbeamer#72), so it
 * lives here once.
 *
 * What stays with each provider is exactly what is genuinely per-vendor:
 * {@link BufferedSocketSessionOptions.sendChunk} and {@link
 * BufferedSocketSessionOptions.endTurn} own the frame encoding and turn-end,
 * {@link BufferedSocketSessionOptions.sendHandshake} the opening payload, and
 * {@link BufferedSocketSessionOptions.handleMessage} the parsing. **Byte
 * accounting is deliberately not here**: a provider that bills per audio-second
 * counts bytes inside its own `sendChunk`/`endTurn`, and one billed by
 * vendor-reported tokens simply does not — the helper never assumes a metering
 * model.
 */
export interface BufferedSocketSessionOptions {
  /** The vendor socket, freshly constructed by the provider. */
  readonly ws: WebSocket;
  /** Bytes per flushed chunk. A real vendor requirement, not a preference. */
  readonly chunkSize: number;
  /**
   * Send one chunk, already sliced to exactly {@link chunkSize}. This is where a
   * per-second-billed provider counts bytes; a token-billed one need not.
   */
  sendChunk(chunk: Buffer): void;
  /** Send the opening handshake. Runs once, the moment the socket opens. */
  sendHandshake(): void;
  /**
   * End the turn: emit the vendor's turn-end for `remaining` — the sub-chunk
   * tail the flush loop left behind (possibly empty). Runs at most once, and
   * only while the socket is open. A provider that ends its turn with a final
   * audio packet sends it here even when `remaining` is empty; one that ends
   * with a control message appends `remaining` only when there is something to
   * append.
   */
  endTurn(remaining: Buffer): void;
  /** Parse one server frame. Never invoked after {@link ASRSession.close}. */
  handleMessage(raw: Buffer): void;
  /** Report a transport-level socket error (not a vendor error frame). */
  onError(err: Error): void;
  /**
   * True when `ws` is already open and configured — handed back from an
   * earlier turn rather than opened by this call (see `qwen-omni.ts`'s
   * sticky sessions). Skips {@link sendHandshake} and the wait for `open`
   * (which an already-open socket will never fire again), and detaches
   * whatever the previous turn left listening on `message`/`error` first, so
   * only this call's own handlers see this turn's events. Default `false`.
   */
  alreadyOpen?: boolean;
}

/**
 * Builds the {@link ASRSession} plumbing shared by the streaming providers. The
 * caller supplies the per-vendor wire behaviour; this owns buffer/ready state,
 * the flush loop, the pre-open finish race, and teardown.
 */
export function createBufferedSocketSession(options: BufferedSocketSessionOptions): ASRSession {
  const {
    ws,
    chunkSize,
    sendChunk,
    sendHandshake,
    endTurn,
    handleMessage,
    onError,
    alreadyOpen = false,
  } = options;

  let buffer = Buffer.alloc(0);
  let ready = alreadyOpen;
  let finishing = false;
  let closed = false;

  function flush() {
    while (buffer.length >= chunkSize) {
      const chunk = buffer.subarray(0, chunkSize);
      buffer = buffer.subarray(chunkSize);
      sendChunk(chunk);
    }
  }

  /** Hand the sub-chunk tail to the provider's turn-end. Open-socket only. */
  function finishTurn() {
    const remaining = buffer;
    buffer = Buffer.alloc(0);
    endTurn(remaining);
  }

  if (alreadyOpen) {
    // The `open` event already fired, on whichever call actually opened this
    // socket — it will not fire again, and a previous turn's own handlers
    // are still attached and must not also see this turn's events.
    ws.removeAllListeners("message");
    ws.removeAllListeners("error");
  } else {
    ws.on("open", () => {
      // A `close()` before the handshake means the session was abandoned while
      // connecting; do not speak into a socket that is being terminated.
      if (closed) return;
      sendHandshake();
      ready = true;
      flush();
      // A clip short enough to finish before the socket opened still has to be
      // sent, or the turn never ends and the session hangs.
      if (finishing) finishTurn();
    });
  }

  ws.on("message", (raw: Buffer) => {
    if (closed) return;
    handleMessage(raw);
  });

  ws.on("error", (err: Error) => {
    if (closed) return;
    onError(err);
    // A transport error leaves the socket half-open; close it so its slot in the
    // vendor's connection pool is released rather than lingering.
    ws.close();
  });

  return {
    sendAudio(chunk: Buffer) {
      if (finishing) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (ready) flush();
    },

    finish() {
      if (finishing) return;
      finishing = true;
      // End the turn only on a live socket. Not open yet: the `open` handler
      // ends it once the handshake has gone out. Ready but no longer OPEN (a
      // post-open error or close): sending would fire a spurious error on a dead
      // socket — the guard BytePlus always had and the other two silently
      // lacked, now settled here for all three (#72).
      if (ready && ws.readyState === WebSocket.OPEN) finishTurn();
    },

    close() {
      if (closed) return;
      closed = true;
      // Stop feeding and finishing; from here the socket is being torn down, not
      // wound down. `terminate` releases the connection immediately in any state
      // (CONNECTING included), which `close()` cannot promise.
      finishing = true;
      ws.terminate();
    },
  };
}
