import { buildBackendSocketUrl } from "./backendSocket.ts";
import { clearLocalConnectionError, setLocalConnectionError } from "./store.ts";

/**
 * Bridges a live recording's captured audio to the backend `/ws`, independent
 * of that socket's readiness.
 *
 * A recording starts capturing audio the instant record is pressed — see
 * `RecordingBar` — without waiting for `/ws` to open. This module owns the
 * socket itself: PCM handed to `sendRecordingAudio` is delivered immediately
 * if the socket is open, or held in order otherwise, so a slow or failed
 * connect never loses audio. If the connect fails or times out, the recording
 * keeps running and the failure surfaces as a retryable error bubble
 * (`setLocalConnectionError`) rather than aborting the recording.
 *
 * Scope: only the *initial* connect is retried here. A connection that did
 * open and then drops mid-recording is a separate problem this does not
 * attempt to solve.
 */

const CONNECT_TIMEOUT_MS = 8000;

interface ConnectionState {
  referenceId: string;
  authToken: string;
  backendUrl: string;
  ws: WebSocket | null;
  /** PCM not yet delivered over an open socket, in capture order. */
  buffer: ArrayBuffer[];
  connectTimeout: ReturnType<typeof setTimeout> | null;
  /** Once the socket has opened once, mid-stream drops are out of scope. */
  opened: boolean;
}

const connections = new Map<string, ConnectionState>();

function clearConnectTimeout(state: ConnectionState): void {
  if (state.connectTimeout === null) return;
  clearTimeout(state.connectTimeout);
  state.connectTimeout = null;
}

function failConnect(state: ConnectionState, message: string): void {
  if (state.opened) return;
  clearConnectTimeout(state);
  setLocalConnectionError(state.referenceId, message);
}

function openSocket(state: ConnectionState): void {
  const wsUrl = buildBackendSocketUrl(state.backendUrl, "/ws", {
    access_token: state.authToken,
    reference_id: state.referenceId,
  });
  const ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";
  state.ws = ws;

  state.connectTimeout = setTimeout(() => {
    if (state.opened) return;
    ws.close();
    failConnect(state, "Connection timed out");
  }, CONNECT_TIMEOUT_MS);

  ws.addEventListener("open", () => {
    clearConnectTimeout(state);
    state.opened = true;
    const buffered = state.buffer;
    state.buffer = [];
    for (const chunk of buffered) ws.send(chunk);
    clearLocalConnectionError(state.referenceId);
  });

  ws.addEventListener("error", () => failConnect(state, "Connection failed"));

  ws.addEventListener("close", () => {
    if (state.ws === ws) state.ws = null;
  });
}

/** Begin tracking a recording's connection and open the socket immediately. */
export function beginRecordingConnection(
  referenceId: string,
  authToken: string,
  backendUrl: string,
): void {
  const state: ConnectionState = {
    referenceId,
    authToken,
    backendUrl,
    ws: null,
    buffer: [],
    connectTimeout: null,
    opened: false,
  };
  connections.set(referenceId, state);
  openSocket(state);
}

/** Deliver (or, while not connected, buffer) one captured PCM chunk. */
export function sendRecordingAudio(referenceId: string, chunk: ArrayBuffer): void {
  const state = connections.get(referenceId);
  if (!state) return;
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(chunk);
  } else {
    state.buffer.push(chunk);
  }
}

/**
 * The user pressed stop. Tell an open socket the recording is done; if the
 * socket never opened, keep the buffered audio and connection state around so
 * a retry can still pick it up.
 */
export function endRecordingConnection(referenceId: string): void {
  const state = connections.get(referenceId);
  if (!state) return;
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: "stop" }));
  }
  if (state.opened) connections.delete(referenceId);
}

/** Re-open the socket and stream whatever was never delivered, from the start. */
export function retryRecordingConnection(referenceId: string): void {
  const state = connections.get(referenceId);
  if (!state || state.opened) return;
  clearConnectTimeout(state);
  state.ws?.close();
  openSocket(state);
}

/** Drop everything for a recording whose error bubble was dismissed. */
export function forgetRecordingConnection(referenceId: string): void {
  const state = connections.get(referenceId);
  if (state) {
    clearConnectTimeout(state);
    state.ws?.close();
    connections.delete(referenceId);
  }
  clearLocalConnectionError(referenceId);
}
