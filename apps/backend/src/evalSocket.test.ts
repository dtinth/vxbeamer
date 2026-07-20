import { afterEach, expect, test, vi } from "vite-plus/test";
import type { WSContext, WSMessageReceive } from "hono/ws";
import type { ASRProvider, ASRSessionCallbacks } from "vxasr";
import type { EvalServerEvent, EvalSocketOptions } from "./evalSocket.ts";
import { createEvalSocketHandler } from "./evalSocket.ts";

const CONFIGURATION_ID = "mock/mock";

/** Records what the handler said and how it hung up. No sockets, no network. */
function createFakeWs() {
  const sent: EvalServerEvent[] = [];
  const closes: { code: number; reason: string }[] = [];
  const ws = {
    send: (data: unknown) => sent.push(JSON.parse(String(data)) as EvalServerEvent),
    close: (code: number, reason: string) => closes.push({ code, reason }),
  } as unknown as WSContext;
  return { ws, sent, closes };
}

/** A provider whose session is driven by the test rather than by audio. */
function createControllableProvider() {
  const audio: Buffer[] = [];
  let callbacks: ASRSessionCallbacks | undefined;
  let finishes = 0;
  let closes = 0;
  const provider: ASRProvider = {
    createSession(cb) {
      callbacks = cb;
      return {
        sendAudio: (chunk) => void audio.push(chunk),
        finish: () => void finishes++,
        close: () => void closes++,
      };
    },
  };
  return {
    provider,
    audio,
    get finishes() {
      return finishes;
    },
    get closes() {
      return closes;
    },
    emit: () => callbacks!,
  };
}

function createOptions(
  overrides: Partial<EvalSocketOptions> & { provider?: ASRProvider } = {},
): EvalSocketOptions {
  const provider = overrides.provider ?? createControllableProvider().provider;
  return {
    configuration: CONFIGURATION_ID,
    // Off by default so behavioural tests do not leave a real timer armed; the
    // idle tests below opt in with an explicit value under fake timers.
    idleTimeoutMs: 0,
    selector: {
      select: () => ({ ok: true, selection: { provider, configurationId: CONFIGURATION_ID } }),
    },
    ...overrides,
  };
}

function textFrame(value: unknown): MessageEvent<WSMessageReceive> {
  return { data: JSON.stringify(value) } as MessageEvent<WSMessageReceive>;
}

function binaryFrame(bytes: ArrayBuffer): MessageEvent<WSMessageReceive> {
  return { data: bytes } as MessageEvent<WSMessageReceive>;
}

// --- The structural guarantee ---
//
// The eval route must not be able to write a message (#38). The enforcement is
// that `evalSocket.ts` cannot reach the store, so this asserts on the import
// graph rather than on behaviour: a behavioural test could only prove that this
// particular path does not store, never that no path can.

test("the eval socket module cannot reach the message store", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("./evalSocket.ts", import.meta.url), "utf8"),
  );

  expect(source).not.toContain('from "./store.ts"');
});

// --- Talking to the client ---

test("announces readiness only once the vendor session exists", () => {
  const controllable = createControllableProvider();
  const handler = createEvalSocketHandler(createOptions({ provider: controllable.provider }));
  const { ws, sent } = createFakeWs();

  handler.onOpen(new Event("open"), ws);

  expect(sent).toEqual([{ type: "ready", configurationId: CONFIGURATION_ID }]);
});

test("streams partials, the final, usage and the end back down the socket", () => {
  const controllable = createControllableProvider();
  const handler = createEvalSocketHandler(createOptions({ provider: controllable.provider }));
  const { ws, sent, closes } = createFakeWs();

  handler.onOpen(new Event("open"), ws);
  controllable.emit().onPartial?.("hello");
  controllable.emit().onUsage?.([{ sku: "asr", unitPrice: 0.001, quantity: 9 }]);
  controllable.emit().onFinal?.("hello world");
  controllable.emit().onEnd?.();

  expect(sent.slice(1)).toEqual([
    { type: "partial", text: "hello" },
    { type: "usage", records: [{ sku: "asr", unitPrice: 0.001, quantity: 9 }] },
    { type: "final", text: "hello world" },
    { type: "end" },
  ]);
  expect(closes).toEqual([{ code: 1000, reason: "done" }]);
});

test("normalizes transcripts exactly as the recording path does", () => {
  const controllable = createControllableProvider();
  const handler = createEvalSocketHandler(createOptions({ provider: controllable.provider }));
  const { ws, sent } = createFakeWs();

  handler.onOpen(new Event("open"), ws);
  controllable.emit().onFinal?.("trailing space   \n\n");

  expect(sent.at(-1)).toEqual({ type: "final", text: "trailing space" });
});

test("forwards binary PCM to the session and stops on the stop frame", () => {
  const controllable = createControllableProvider();
  const handler = createEvalSocketHandler(createOptions({ provider: controllable.provider }));
  const { ws } = createFakeWs();

  handler.onOpen(new Event("open"), ws);
  handler.onMessage(binaryFrame(new Uint8Array([1, 2, 3, 4]).buffer), ws);
  handler.onMessage(textFrame({ type: "stop" }), ws);

  expect(controllable.audio).toHaveLength(1);
  expect([...controllable.audio[0]!]).toEqual([1, 2, 3, 4]);
  expect(controllable.finishes).toBe(1);
});

test("a client that hangs up without stopping still finishes the session once", () => {
  const controllable = createControllableProvider();
  const handler = createEvalSocketHandler(createOptions({ provider: controllable.provider }));
  const { ws } = createFakeWs();

  handler.onOpen(new Event("open"), ws);
  handler.onClose();
  handler.onClose();

  expect(controllable.finishes).toBe(1);
});

test("a stop frame is honoured once, however many arrive", () => {
  const controllable = createControllableProvider();
  const handler = createEvalSocketHandler(createOptions({ provider: controllable.provider }));
  const { ws } = createFakeWs();

  handler.onOpen(new Event("open"), ws);
  handler.onMessage(textFrame({ type: "stop" }), ws);
  handler.onMessage(textFrame({ type: "stop" }), ws);
  handler.onClose();

  expect(controllable.finishes).toBe(1);
});

test("malformed text frames are ignored", () => {
  const controllable = createControllableProvider();
  const handler = createEvalSocketHandler(createOptions({ provider: controllable.provider }));
  const { ws } = createFakeWs();

  handler.onOpen(new Event("open"), ws);
  handler.onMessage({ data: "not json{" } as MessageEvent<WSMessageReceive>, ws);

  expect(controllable.finishes).toBe(0);
});

// --- Failing ---

test("a vendor error arrives as a message the close reason could not carry", () => {
  const controllable = createControllableProvider();
  const handler = createEvalSocketHandler(createOptions({ provider: controllable.provider }));
  const { ws, sent, closes } = createFakeWs();
  const longMessage = `vendor rejected the stream: ${"detail ".repeat(40)}`;

  handler.onOpen(new Event("open"), ws);
  controllable.emit().onError?.(new Error(longMessage));

  expect(sent.at(-1)).toEqual({ type: "error", message: longMessage });
  expect(closes).toEqual([{ code: 1011, reason: "ASR error" }]);
});

test("a configuration this server will not serve closes with 1008", () => {
  const handler = createEvalSocketHandler({
    configuration: "someone/else",
    selector: {
      select: () => ({ ok: false, code: "not_enabled", message: 'not enabled: "someone/else"' }),
    },
  });
  const { ws, sent, closes } = createFakeWs();

  handler.onOpen(new Event("open"), ws);

  expect(sent).toEqual([]);
  expect(closes).toEqual([{ code: 1008, reason: 'not enabled: "someone/else"' }]);
});

test("a server missing credentials closes with 1011", () => {
  const handler = createEvalSocketHandler({
    configuration: CONFIGURATION_ID,
    selector: {
      select: () => ({
        ok: false,
        code: "not_configured",
        message: "DASHSCOPE_API_KEY not configured",
      }),
    },
  });
  const { ws, closes } = createFakeWs();

  handler.onOpen(new Event("open"), ws);

  expect(closes).toEqual([{ code: 1011, reason: "DASHSCOPE_API_KEY not configured" }]);
});

test("nothing is said down a socket that has already closed", () => {
  const controllable = createControllableProvider();
  const handler = createEvalSocketHandler(createOptions({ provider: controllable.provider }));
  const { ws, sent, closes } = createFakeWs();

  handler.onOpen(new Event("open"), ws);
  controllable.emit().onEnd?.();
  // A vendor that keeps talking after its own end must not reopen the socket.
  controllable.emit().onPartial?.("too late");
  controllable.emit().onError?.(new Error("also too late"));

  expect(sent.filter((event) => event.type === "partial")).toEqual([]);
  expect(closes).toEqual([{ code: 1000, reason: "done" }]);
});

test("the configuration named by the client is the one selected", () => {
  const select = vi.fn(() => ({
    ok: true as const,
    selection: {
      provider: createControllableProvider().provider,
      configurationId: "qwen/qwen3-asr-flash-realtime+groq",
    },
  }));
  const handler = createEvalSocketHandler({
    configuration: "qwen/qwen3-asr-flash-realtime+groq",
    selector: { select },
  });
  const { ws, sent } = createFakeWs();

  handler.onOpen(new Event("open"), ws);

  expect(select).toHaveBeenCalledWith({ configuration: "qwen/qwen3-asr-flash-realtime+groq" });
  expect(sent[0]).toEqual({
    type: "ready",
    configurationId: "qwen/qwen3-asr-flash-realtime+groq",
  });
});

// --- Kicking an idle session ---
//
// Each open session holds one vendor connection, and the vendors cap those per
// account ("connections too much max_connections 100"). A client that opens a
// socket and then falls silent — never sending `stop`, never hanging up — would
// otherwise pin its connection until the vendor reaps it, so the watchdog
// reclaims it. The eval fan-out makes this sharper: it opens one socket per
// configuration, so a single stalled run can hold several slots at once.

afterEach(() => {
  vi.useRealTimers();
});

test("kicks a session that goes silent, aborting the vendor connection", () => {
  vi.useFakeTimers();
  const controllable = createControllableProvider();
  const handler = createEvalSocketHandler(
    createOptions({ provider: controllable.provider, idleTimeoutMs: 60_000 }),
  );
  const { ws, sent, closes } = createFakeWs();

  handler.onOpen(new Event("open"), ws);
  vi.advanceTimersByTime(60_000);

  // `close()`, not `finish()`: an abandoned session must be aborted, since the
  // graceful finish waits for a terminal event silence will never produce.
  expect(controllable.closes).toBe(1);
  expect(controllable.finishes).toBe(0);
  expect(sent.at(-1)).toEqual({
    type: "error",
    message: "Idle timeout: no audio received for 60s",
  });
  expect(closes).toEqual([{ code: 1008, reason: "idle timeout" }]);
});

test("audio frames defer the idle deadline", () => {
  vi.useFakeTimers();
  const controllable = createControllableProvider();
  const handler = createEvalSocketHandler(
    createOptions({ provider: controllable.provider, idleTimeoutMs: 60_000 }),
  );
  const { ws, closes } = createFakeWs();

  handler.onOpen(new Event("open"), ws);
  // Audio just under the deadline, repeatedly: the session must survive as long
  // as it keeps sending.
  for (let i = 0; i < 5; i++) {
    vi.advanceTimersByTime(59_000);
    handler.onMessage(binaryFrame(new Uint8Array([1]).buffer), ws);
  }
  expect(closes).toEqual([]);
  expect(controllable.closes).toBe(0);

  // Then let it fall silent past the deadline.
  vi.advanceTimersByTime(60_000);
  expect(closes).toEqual([{ code: 1008, reason: "idle timeout" }]);
});

test("a session that has stopped is not later kicked as idle", () => {
  vi.useFakeTimers();
  const controllable = createControllableProvider();
  const handler = createEvalSocketHandler(
    createOptions({ provider: controllable.provider, idleTimeoutMs: 60_000 }),
  );
  const { ws, closes } = createFakeWs();

  handler.onOpen(new Event("open"), ws);
  handler.onMessage(textFrame({ type: "stop" }), ws);
  // The vendor may take longer than the idle window to finalise; that wait is
  // the vendor's, not the client's, so the watchdog is disarmed on `stop`.
  vi.advanceTimersByTime(600_000);

  expect(controllable.finishes).toBe(1);
  expect(controllable.closes).toBe(0);
  expect(closes).toEqual([]);
});

test("idle-kicking is disabled by a non-positive timeout", () => {
  vi.useFakeTimers();
  const controllable = createControllableProvider();
  const handler = createEvalSocketHandler(
    createOptions({ provider: controllable.provider, idleTimeoutMs: 0 }),
  );
  const { ws, closes } = createFakeWs();

  handler.onOpen(new Event("open"), ws);
  vi.advanceTimersByTime(600_000);

  expect(closes).toEqual([]);
  expect(controllable.closes).toBe(0);
});
