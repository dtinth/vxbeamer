import type { WSMessageReceive } from "hono/ws";

/**
 * Decodes the two frame shapes both audio sockets speak.
 *
 * `/ws` and `/asr/eval` receive the same wire: PCM as binary frames, control as
 * JSON text. The decode is fiddly in the same way for both — a binary frame can
 * arrive as an `ArrayBuffer` or as a typed-array *view* onto a larger buffer,
 * and the view's `byteOffset`/`byteLength` must be honoured or the wrong bytes
 * get transcribed. That care is exactly what rots when copied, so it lives here
 * once (dtinth/vxbeamer#72).
 *
 * This module reaches nothing in the message log, so sharing it does not weaken
 * `evalSocket.ts`'s deliberate isolation from the store: a frame decoder has no
 * business there and imports none of it.
 */

/**
 * Returns the PCM in a binary frame, or `null` if the frame is not binary (a
 * text control frame). An empty binary frame yields an empty buffer, not
 * `null` — absence of audio is distinct from "not an audio frame".
 */
export function readAudioFrame(data: WSMessageReceive): Buffer | null {
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) {
    // Honour the view's window: a typed array can be a slice of a larger buffer,
    // and copying the whole backing buffer would send neighbouring bytes.
    return Buffer.from(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
  }
  return null;
}

/** Whether a frame is the `{"type":"stop"}` control message. */
export function isStopMessage(data: WSMessageReceive): boolean {
  if (typeof data !== "string") return false;
  try {
    const message = JSON.parse(data) as { type?: string };
    return message.type === "stop";
  } catch {
    // A text frame that is not JSON is not a stop; ignore it.
    return false;
  }
}
