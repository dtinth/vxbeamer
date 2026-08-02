import { buildBackendSocketUrl } from "./backendSocket.ts";
import { clearLocalConnectionError, obtainSessionToken, setLocalConnectionError } from "./store.ts";

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

/**
 * One id per page load, not saved anywhere — a refresh always starts fresh
 * (dtinth/vxbeamer#99). Lets the backend recognise every `/ws` connection
 * from this tab as the same caller, so a provider that supports it (currently
 * only `qwen-omni`) can keep its vendor connection open between recordings
 * and carry context from one to the next. A provider with no notion of this
 * just ignores it — sending it costs nothing when it isn't useful.
 */
const CLIENT_ID = crypto.randomUUID();

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
  /** The user pressed stop before this ever opened — finish up once it does. */
  stopped: boolean;
  /** A retry's token refresh is in flight — guards against a double-tap. */
  retrying: boolean;
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
    client_id: CLIENT_ID,
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
    // Stop was already requested while this was still connecting — the
    // original stop message never went out, so send it now and finish up.
    if (state.stopped) {
      ws.send(JSON.stringify({ type: "stop" }));
      connections.delete(state.referenceId);
    }
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
    stopped: false,
    retrying: false,
  };
  connections.set(referenceId, state);
  openSocket(state);
}

/** Deliver (or, while still connecting, buffer) one captured PCM chunk. */
export function sendRecordingAudio(referenceId: string, chunk: ArrayBuffer): void {
  const state = connections.get(referenceId);
  if (!state) return;
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(chunk);
  } else if (!state.opened) {
    // Once opened, a drop is a mid-stream problem this module doesn't
    // attempt to solve (see the module doc comment) — nothing left to buffer
    // for.
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
  if (state.opened) {
    connections.delete(referenceId);
  } else {
    state.stopped = true;
  }
}

/**
 * Re-open the socket and stream whatever was never delivered, from the start.
 *
 * Fetches a fresh access token before reconnecting rather than reusing the
 * one captured at the original connect attempt: real time can pass between a
 * failed connect and the user tapping retry — long enough, on an unstable
 * connection, for that token to have expired. The backend rejects an expired
 * token by failing the WebSocket upgrade immediately (an HTTP 401 before the
 * socket ever opens), which reads to the user as the retry doing nothing at
 * all — a new recording works fine in the meantime because it reads a
 * current token fresh, not a stale, minutes-old snapshot (dtinth/vxbeamer#86).
 */
export function retryRecordingConnection(referenceId: string): void {
  const state = connections.get(referenceId);
  if (!state || state.opened || state.retrying) return;
  state.retrying = true;
  clearConnectTimeout(state);
  state.ws?.close();
  // Otherwise a retry that fails the same way leaves the bubble showing the
  // exact same text it did before the tap — indistinguishable from the tap
  // having done nothing at all.
  setLocalConnectionError(referenceId, "Retrying…");

  void obtainSessionToken()
    .then((authToken) => {
      // Forgotten, or the connection opened some other way, while the token
      // refresh was in flight.
      if (connections.get(referenceId) !== state || state.opened) return;
      state.retrying = false;
      state.authToken = authToken;
      openSocket(state);
    })
    .catch((err) => {
      if (connections.get(referenceId) !== state || state.opened) return;
      state.retrying = false;
      failConnect(state, err instanceof Error ? err.message : "Could not refresh session");
    });
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
