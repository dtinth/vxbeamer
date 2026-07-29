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
    this.readyState = 3;
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

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.unstubAllGlobals();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("localStorage", createStorage());
  FakeWebSocket.instances = [];
});

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

test("surfaces a local connection error on connect failure, without losing buffered audio", async () => {
  const [{ beginRecordingConnection, sendRecordingAudio }, { $visibleMessages }] =
    await Promise.all([import("./recordingConnection.ts"), import("./store.ts")]);

  beginRecordingConnection("ref-1", "token", "https://backend.example");
  const chunk = new ArrayBuffer(4);
  sendRecordingAudio("ref-1", chunk);
  FakeWebSocket.instances[0]!.triggerError();

  const placeholder = $visibleMessages.get().get("local:ref-1");
  expect(placeholder).toMatchObject({ status: "error", connectionError: true });
});

test("retrying replays every buffered chunk into a fresh socket, from the start", async () => {
  const [
    { beginRecordingConnection, sendRecordingAudio, retryRecordingConnection },
    { $visibleMessages },
  ] = await Promise.all([import("./recordingConnection.ts"), import("./store.ts")]);

  beginRecordingConnection("ref-1", "token", "https://backend.example");
  const chunkA = new ArrayBuffer(4);
  sendRecordingAudio("ref-1", chunkA);
  FakeWebSocket.instances[0]!.triggerError();

  // Recording keeps running after the failed connect — more audio arrives.
  const chunkB = new ArrayBuffer(4);
  sendRecordingAudio("ref-1", chunkB);

  retryRecordingConnection("ref-1");
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

  beginRecordingConnection("ref-1", "token", "https://backend.example");
  FakeWebSocket.instances[0]!.triggerError();
  expect($visibleMessages.get().get("local:ref-1")?.error).toBe("Connection failed");

  retryRecordingConnection("ref-1");
  expect($visibleMessages.get().get("local:ref-1")?.error).toBe("Retrying…");

  // Fails the same way again — the text changes once more, proving the retry
  // actually ran rather than the bubble just sitting on "Retrying…" forever.
  FakeWebSocket.instances[1]!.triggerError();
  expect($visibleMessages.get().get("local:ref-1")?.error).toBe("Connection failed");
});

test("treats a hung connect as a failure once the timeout elapses", async () => {
  const [{ beginRecordingConnection }, { $visibleMessages }] = await Promise.all([
    import("./recordingConnection.ts"),
    import("./store.ts"),
  ]);

  beginRecordingConnection("ref-1", "token", "https://backend.example");
  const ws = FakeWebSocket.instances[0]!;

  vi.advanceTimersByTime(8000);

  expect(ws.readyState).toBe(3);
  expect($visibleMessages.get().get("local:ref-1")?.error).toBe("Connection timed out");
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

  beginRecordingConnection("ref-1", "token", "https://backend.example");
  FakeWebSocket.instances[0]!.triggerError();

  endRecordingConnection("ref-1");
  retryRecordingConnection("ref-1");

  expect(FakeWebSocket.instances).toHaveLength(2);
});

test("a retry that succeeds after stop sends the deferred stop and cleans up", async () => {
  const { beginRecordingConnection, endRecordingConnection, retryRecordingConnection } =
    await import("./recordingConnection.ts");

  beginRecordingConnection("ref-1", "token", "https://backend.example");
  FakeWebSocket.instances[0]!.triggerError();
  endRecordingConnection("ref-1");

  retryRecordingConnection("ref-1");
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
  const ws = FakeWebSocket.instances[0]!;
  ws.triggerError();
  expect($visibleMessages.get().has("local:ref-1")).toBe(true);

  forgetRecordingConnection("ref-1");
  expect(ws.readyState).toBe(3);
  expect($visibleMessages.get().has("local:ref-1")).toBe(false);

  retryRecordingConnection("ref-1");
  expect(FakeWebSocket.instances).toHaveLength(1);
});

test("forgetting a connection with no error bubble showing is a no-op, not a crash", async () => {
  const { forgetRecordingConnection } = await import("./recordingConnection.ts");

  expect(() => forgetRecordingConnection("never-started")).not.toThrow();
});
