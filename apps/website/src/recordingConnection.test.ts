import { beforeEach, expect, test, vi } from "vite-plus/test";
import { createStorage } from "./testStorage.ts";

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];

  url: string;
  binaryType = "";
  readyState = 0;
  sent: (ArrayBuffer | string)[] = [];
  private listeners: Record<string, Array<() => void>> = {};

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, cb: () => void): void {
    (this.listeners[type] ??= []).push(cb);
  }

  send(data: ArrayBuffer | string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === 3) return;
    // Per the real WebSocket spec, closing a still-CONNECTING socket "fails"
    // it — that raises `error` (then `close`), not just `close`. A test
    // double that skipped this would never catch a caller assuming a single
    // failure signal per attempt (dtinth/vxbeamer#86). Deferred with a
    // microtask, not fired inline: a real browser dispatches these
    // asynchronously too, which matters here — a caller that already acted
    // synchronously on its own "this failed" branch (e.g. a connect timeout)
    // must win the race against this trailing `error`, not the other way
    // round.
    const wasConnecting = this.readyState === 0;
    this.readyState = 3;
    if (wasConnecting) {
      void Promise.resolve().then(() => this.listeners.error?.forEach((cb) => cb()));
    }
    this.listeners.close?.forEach((cb) => cb());
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.listeners.open?.forEach((cb) => cb());
  }

  triggerError(): void {
    this.listeners.error?.forEach((cb) => cb());
  }
}

function encodeToken(payload: Record<string, unknown>): string {
  const base64 = btoa(JSON.stringify(payload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `header.${base64}.signature`;
}

/** A retry now fetches a fresh token first — most retry tests need one signed in. */
async function signIn(): Promise<void> {
  const { saveSessionToken } = await import("./store.ts");
  const nowSeconds = Math.floor(Date.now() / 1000);
  saveSessionToken(
    encodeToken({ sub: "user-1", iat: nowSeconds, exp: nowSeconds + 3600 }),
    "refresh-token",
  );
}

/**
 * Signs in with a token in the zone `obtainSessionToken` blocks to refresh:
 * not fresh (well past `FRESH_THRESHOLD_SECONDS`) and near expiry (well
 * within `EXPIRY_BUFFER_SECONDS`). Returns the stale token, so a test can
 * confirm it — not the refreshed one — is what an old socket used.
 */
async function signInWithNearExpiryToken(): Promise<{ staleToken: string }> {
  const { setBackendUrl, saveSessionToken } = await import("./store.ts");
  setBackendUrl("https://backend.example");
  const nowSeconds = Math.floor(Date.now() / 1000);
  const staleToken = encodeToken({ sub: "user-1", iat: nowSeconds - 1000, exp: nowSeconds + 60 });
  saveSessionToken(staleToken, "refresh-token");
  return { staleToken };
}

/** A `fetch` stand-in for `POST /auth/refresh` whose response is under the test's control. */
function deferredRefreshFetch(): {
  fetchMock: ReturnType<typeof vi.fn>;
  respond: (accessToken: string) => void;
} {
  let resolve!: (response: unknown) => void;
  const response = new Promise((res) => {
    resolve = res;
  });
  const fetchMock = vi.fn(() => response);
  return {
    fetchMock,
    respond(accessToken) {
      resolve({
        ok: true,
        status: 200,
        json: async () => ({ access_token: accessToken, refresh_token: "new-refresh-token" }),
      });
    },
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.unstubAllGlobals();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("localStorage", createStorage());
  FakeWebSocket.instances = [];
});

/**
 * Fails the most recent connect attempt, over and over, until the initial
 * connect's 3 silent auto-retries (dtinth/vxbeamer#86) are used up and the
 * failure finally surfaces as a visible error, one second apart each. Leaves
 * `FakeWebSocket.instances` with 4 entries: the original attempt plus 3
 * retries.
 */
async function exhaustAutoRetries(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    FakeWebSocket.instances.at(-1)!.triggerError();
    await vi.advanceTimersByTimeAsync(1000);
  }
  FakeWebSocket.instances.at(-1)!.triggerError();
}

test("buffers audio while connecting and flushes it in order once the socket opens", async () => {
  const { beginRecordingConnection, sendRecordingAudio } = await import("./recordingConnection.ts");

  beginRecordingConnection("ref-1", "token", "https://backend.example");
  const chunkA = new ArrayBuffer(4);
  const chunkB = new ArrayBuffer(4);
  sendRecordingAudio("ref-1", chunkA);
  sendRecordingAudio("ref-1", chunkB);

  const ws = FakeWebSocket.instances[0]!;
  expect(ws.sent).toEqual([]);

  ws.open();
  expect(ws.sent).toEqual([chunkA, chunkB]);
});

test("sends audio immediately once the socket is already open", async () => {
  const { beginRecordingConnection, sendRecordingAudio } = await import("./recordingConnection.ts");

  beginRecordingConnection("ref-1", "token", "https://backend.example");
  FakeWebSocket.instances[0]!.open();

  const chunk = new ArrayBuffer(4);
  sendRecordingAudio("ref-1", chunk);

  expect(FakeWebSocket.instances[0]!.sent).toEqual([chunk]);
});

test("surfaces a local connection error only once auto-retry is exhausted, without losing buffered audio", async () => {
  const [{ beginRecordingConnection, sendRecordingAudio }, { $visibleMessages }] =
    await Promise.all([import("./recordingConnection.ts"), import("./store.ts")]);

  beginRecordingConnection("ref-1", "token", "https://backend.example");
  const chunk = new ArrayBuffer(4);
  sendRecordingAudio("ref-1", chunk);
  await exhaustAutoRetries();

  const placeholder = $visibleMessages.get().get("local:ref-1");
  expect(placeholder).toMatchObject({ status: "error", connectionError: true });
});

// --- Auto-retry on the initial connect (dtinth/vxbeamer#86) ---

test("a single connect failure retries silently, with no error shown yet", async () => {
  const [{ beginRecordingConnection }, { $visibleMessages }] = await Promise.all([
    import("./recordingConnection.ts"),
    import("./store.ts"),
  ]);

  beginRecordingConnection("ref-1", "token", "https://backend.example");
  FakeWebSocket.instances[0]!.triggerError();

  expect($visibleMessages.get().has("local:ref-1")).toBe(false);
  expect(FakeWebSocket.instances).toHaveLength(1); // the retry hasn't fired yet

  await vi.advanceTimersByTimeAsync(1000);
  expect(FakeWebSocket.instances).toHaveLength(2);
  expect($visibleMessages.get().has("local:ref-1")).toBe(false);
});

test("each auto-retry is spaced one second apart, not sooner", async () => {
  const { beginRecordingConnection } = await import("./recordingConnection.ts");

  beginRecordingConnection("ref-1", "token", "https://backend.example");
  FakeWebSocket.instances[0]!.triggerError();

  await vi.advanceTimersByTimeAsync(999);
  expect(FakeWebSocket.instances).toHaveLength(1); // one ms early — not yet

  await vi.advanceTimersByTimeAsync(1);
  expect(FakeWebSocket.instances).toHaveLength(2);
});

test("exactly 3 auto-retries happen before the error becomes visible", async () => {
  const [{ beginRecordingConnection }, { $visibleMessages }] = await Promise.all([
    import("./recordingConnection.ts"),
    import("./store.ts"),
  ]);

  beginRecordingConnection("ref-1", "token", "https://backend.example");
  await exhaustAutoRetries();

  // The original attempt plus 3 retries — 4 sockets total.
  expect(FakeWebSocket.instances).toHaveLength(4);
  expect($visibleMessages.get().get("local:ref-1")?.error).toBe("Connection failed");
});

test("an auto-retry that succeeds opens normally, with no error ever shown", async () => {
  const [{ beginRecordingConnection, sendRecordingAudio }, { $visibleMessages }] =
    await Promise.all([import("./recordingConnection.ts"), import("./store.ts")]);

  beginRecordingConnection("ref-1", "token", "https://backend.example");
  const chunk = new ArrayBuffer(4);
  sendRecordingAudio("ref-1", chunk);
  FakeWebSocket.instances[0]!.triggerError();
  await vi.advanceTimersByTimeAsync(1000);

  const retried = FakeWebSocket.instances[1]!;
  retried.open();

  expect(retried.sent).toEqual([chunk]);
  expect($visibleMessages.get().has("local:ref-1")).toBe(false);
});

test("a hung connect (timeout, not an error event) also auto-retries before surfacing", async () => {
  const [{ beginRecordingConnection }, { $visibleMessages }] = await Promise.all([
    import("./recordingConnection.ts"),
    import("./store.ts"),
  ]);

  beginRecordingConnection("ref-1", "token", "https://backend.example");
  const first = FakeWebSocket.instances[0]!;

  // The first 3 timeouts (8s each) are silently retried, 1s apart.
  await vi.advanceTimersByTimeAsync(9000 * 3);
  expect(FakeWebSocket.instances).toHaveLength(4);
  expect(first.readyState).toBe(3); // closed by its own timeout, same as before
  expect($visibleMessages.get().has("local:ref-1")).toBe(false);

  // Auto-retry is spent — the 4th timeout is the one that surfaces.
  await vi.advanceTimersByTimeAsync(8000);
  expect(FakeWebSocket.instances.at(-1)!.readyState).toBe(3);
  expect($visibleMessages.get().get("local:ref-1")?.error).toBe("Connection timed out");
});

test("a manual retry pre-empts a pending auto-retry rather than racing it", async () => {
  const { beginRecordingConnection, retryRecordingConnection } =
    await import("./recordingConnection.ts");
  await signIn();

  beginRecordingConnection("ref-1", "token", "https://backend.example");
  FakeWebSocket.instances[0]!.triggerError(); // schedules a silent auto-retry

  retryRecordingConnection("ref-1");
  await vi.advanceTimersByTimeAsync(0); // let the token refresh settle
  expect(FakeWebSocket.instances).toHaveLength(2); // the manual retry's socket

  // If the cancelled auto-retry still fired, this would open a 3rd socket.
  await vi.advanceTimersByTimeAsync(1000);
  expect(FakeWebSocket.instances).toHaveLength(2);
});

test("retrying replays every buffered chunk into a fresh socket, from the start", async () => {
  const [
    { beginRecordingConnection, sendRecordingAudio, retryRecordingConnection },
    { $visibleMessages },
  ] = await Promise.all([import("./recordingConnection.ts"), import("./store.ts")]);
  await signIn();

  beginRecordingConnection("ref-1", "token", "https://backend.example");
  const chunkA = new ArrayBuffer(4);
  sendRecordingAudio("ref-1", chunkA);
  FakeWebSocket.instances[0]!.triggerError();

  // Recording keeps running after the failed connect — more audio arrives.
  const chunkB = new ArrayBuffer(4);
  sendRecordingAudio("ref-1", chunkB);

  retryRecordingConnection("ref-1");
  await vi.advanceTimersByTimeAsync(0); // let the token refresh settle
  expect(FakeWebSocket.instances).toHaveLength(2);

  const retried = FakeWebSocket.instances[1]!;
  retried.open();
  expect(retried.sent).toEqual([chunkA, chunkB]);
  expect($visibleMessages.get().has("local:ref-1")).toBe(false);
});

test("retrying shows a distinct 'Retrying…' state, not the stale failure text", async () => {
  // Otherwise a retry that fails the same way leaves the bubble showing
  // exactly what it showed before the tap — indistinguishable from the tap
  // having done nothing.
  const [{ beginRecordingConnection, retryRecordingConnection }, { $visibleMessages }] =
    await Promise.all([import("./recordingConnection.ts"), import("./store.ts")]);
  await signIn();

  beginRecordingConnection("ref-1", "token", "https://backend.example");
  await exhaustAutoRetries();
  expect($visibleMessages.get().get("local:ref-1")?.error).toBe("Connection failed");

  retryRecordingConnection("ref-1");
  // The bubble updates immediately, before the token refresh even settles.
  expect($visibleMessages.get().get("local:ref-1")?.error).toBe("Retrying…");
  await vi.advanceTimersByTimeAsync(0); // let the token refresh settle

  // Fails the same way again — the text changes once more, proving the retry
  // actually ran rather than the bubble just sitting on "Retrying…" forever.
  // A manual retry's own failure is never auto-retried again — it shows
  // right away.
  FakeWebSocket.instances.at(-1)!.triggerError();
  expect($visibleMessages.get().get("local:ref-1")?.error).toBe("Connection failed");
});

test("a retry refreshes a near-expiry token instead of reusing the one the recording started with", async () => {
  // The bug this guards against (dtinth/vxbeamer#86): on an unstable
  // connection, real time can pass between the original failed connect and
  // the user tapping retry — long enough for the token captured at
  // `beginRecordingConnection` to go stale. The backend rejects a stale token
  // by failing the WS upgrade immediately, which read to the user as "the
  // retry did nothing".
  const { beginRecordingConnection, retryRecordingConnection } =
    await import("./recordingConnection.ts");
  const { staleToken } = await signInWithNearExpiryToken();
  const refreshedToken = encodeToken({
    sub: "user-1",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const { fetchMock, respond } = deferredRefreshFetch();
  vi.stubGlobal("fetch", fetchMock);

  // Captured once, as RecordingBar does — the same stale token throughout.
  beginRecordingConnection("ref-1", staleToken, "https://backend.example");
  expect(FakeWebSocket.instances[0]!.url).toContain(`access_token=${staleToken}`);
  FakeWebSocket.instances[0]!.triggerError();

  retryRecordingConnection("ref-1");
  respond(refreshedToken);
  await vi.advanceTimersByTimeAsync(0); // let the blocking refresh settle

  expect(fetchMock).toHaveBeenCalledOnce();
  expect(FakeWebSocket.instances).toHaveLength(2);
  expect(FakeWebSocket.instances[1]!.url).toContain(`access_token=${refreshedToken}`);
  expect(FakeWebSocket.instances[1]!.url).not.toContain(staleToken);
});

test("forgetting a connection while its retry's token refresh is still pending is a no-op once it settles", async () => {
  const { beginRecordingConnection, retryRecordingConnection, forgetRecordingConnection } =
    await import("./recordingConnection.ts");
  const { staleToken } = await signInWithNearExpiryToken();
  const { fetchMock, respond } = deferredRefreshFetch();
  vi.stubGlobal("fetch", fetchMock);

  beginRecordingConnection("ref-1", staleToken, "https://backend.example");
  FakeWebSocket.instances[0]!.triggerError();

  retryRecordingConnection("ref-1");
  // The user swipes the bubble away before the refresh has even resolved.
  forgetRecordingConnection("ref-1");
  respond(encodeToken({ sub: "user-1", exp: Math.floor(Date.now() / 1000) + 3600 }));
  await vi.advanceTimersByTimeAsync(0);

  // No socket reopens for a connection nobody is tracking any more.
  expect(FakeWebSocket.instances).toHaveLength(1);
});

test("double-tapping retry before the token refresh settles opens only one new socket", async () => {
  const { beginRecordingConnection, retryRecordingConnection } =
    await import("./recordingConnection.ts");
  const { staleToken } = await signInWithNearExpiryToken();
  const { fetchMock, respond } = deferredRefreshFetch();
  vi.stubGlobal("fetch", fetchMock);

  beginRecordingConnection("ref-1", staleToken, "https://backend.example");
  FakeWebSocket.instances[0]!.triggerError();

  retryRecordingConnection("ref-1");
  retryRecordingConnection("ref-1"); // impatient second tap, same failed bubble
  respond(encodeToken({ sub: "user-1", exp: Math.floor(Date.now() / 1000) + 3600 }));
  await vi.advanceTimersByTimeAsync(0);

  expect(fetchMock).toHaveBeenCalledOnce();
  expect(FakeWebSocket.instances).toHaveLength(2);
});

test("a socket that opens before the timeout is not later closed by it", async () => {
  const { beginRecordingConnection } = await import("./recordingConnection.ts");

  beginRecordingConnection("ref-1", "token", "https://backend.example");
  const ws = FakeWebSocket.instances[0]!;
  ws.open();

  vi.advanceTimersByTime(8000);

  expect(ws.readyState).toBe(FakeWebSocket.OPEN);
});

test("stopping after a successful connect forgets the connection (no retry state left)", async () => {
  const { beginRecordingConnection, endRecordingConnection, retryRecordingConnection } =
    await import("./recordingConnection.ts");

  beginRecordingConnection("ref-1", "token", "https://backend.example");
  FakeWebSocket.instances[0]!.open();

  endRecordingConnection("ref-1");
  retryRecordingConnection("ref-1");

  // Nothing to retry — no second socket should have been opened.
  expect(FakeWebSocket.instances).toHaveLength(1);
});

test("stopping while still failed keeps the connection retryable", async () => {
  const { beginRecordingConnection, endRecordingConnection, retryRecordingConnection } =
    await import("./recordingConnection.ts");
  await signIn();

  beginRecordingConnection("ref-1", "token", "https://backend.example");
  FakeWebSocket.instances[0]!.triggerError();

  endRecordingConnection("ref-1");
  retryRecordingConnection("ref-1");
  await vi.advanceTimersByTimeAsync(0); // let the token refresh settle

  expect(FakeWebSocket.instances).toHaveLength(2);
});

test("a retry that succeeds after stop sends the deferred stop and cleans up", async () => {
  const { beginRecordingConnection, endRecordingConnection, retryRecordingConnection } =
    await import("./recordingConnection.ts");
  await signIn();

  beginRecordingConnection("ref-1", "token", "https://backend.example");
  FakeWebSocket.instances[0]!.triggerError();
  endRecordingConnection("ref-1");

  retryRecordingConnection("ref-1");
  await vi.advanceTimersByTimeAsync(0); // let the token refresh settle
  const retried = FakeWebSocket.instances[1]!;
  retried.open();

  // endRecordingConnection's original stop send was skipped (nothing was open
  // yet), so it must go out once the retry actually connects.
  expect(retried.sent).toContain(JSON.stringify({ type: "stop" }));

  // Fully resolved — nothing left to retry, no lingering state.
  retryRecordingConnection("ref-1");
  expect(FakeWebSocket.instances).toHaveLength(2);
});

test("forgetting a connection closes the socket and drops its retry state", async () => {
  const { beginRecordingConnection, forgetRecordingConnection, retryRecordingConnection } =
    await import("./recordingConnection.ts");
  const { $visibleMessages } = await import("./store.ts");

  beginRecordingConnection("ref-1", "token", "https://backend.example");
  await exhaustAutoRetries();
  expect($visibleMessages.get().has("local:ref-1")).toBe(true);

  const current = FakeWebSocket.instances.at(-1)!;
  const socketCountBeforeForget = FakeWebSocket.instances.length;
  forgetRecordingConnection("ref-1");
  expect(current.readyState).toBe(3);
  expect($visibleMessages.get().has("local:ref-1")).toBe(false);

  retryRecordingConnection("ref-1");
  expect(FakeWebSocket.instances).toHaveLength(socketCountBeforeForget);
});

test("forgetting a connection with no error bubble showing is a no-op, not a crash", async () => {
  const { forgetRecordingConnection } = await import("./recordingConnection.ts");

  expect(() => forgetRecordingConnection("never-started")).not.toThrow();
});
