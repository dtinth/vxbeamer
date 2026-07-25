import { expect, test } from "vite-plus/test";
import {
  buildEvalSocketUrl,
  canWinEval,
  evalDurationSeconds,
  evalFrameIntervalMs,
  evalRowCost,
  EVAL_FRAME_BYTES,
  EVAL_FRAME_INTERVAL_MS,
  startEvalRun,
  toPacedFrames,
  type EvalConfiguration,
  type EvalRow,
  type EvalServerEvent,
  type EvalSocketHandlers,
  type EvalTimers,
} from "./evalRun.ts";

const QWEN = "qwen/qwen3-asr-flash-realtime";
const QWEN_GROQ = "qwen/qwen3-asr-flash-realtime+groq";
const BYTEPLUS = "byteplus/bigmodel";
// Stands in for a provider that has never been fast-dump tested — the tests
// that exist to prove realtime pacing doesn't burst need one of these, since
// every provider actually in the catalogue is now confirmed fast-dump safe.
const SLOW_VENDOR = "future-vendor/model-v1";

// The two transcripts below are real output from a 9 s Thai clip. They are the
// point of the feature: same audio, same second, wildly different answers.
const QWEN_TRANSCRIPT =
  "project นี้เขียนด้วยภาษา TypeScript ใช้ framework ชื่อ Elysia " +
  "โดย deploy ไปที่ Railway และใช้ MongoDB Atlas เป็นผู้ให้บริการฐานข้อมูล.";
const BYTEPLUS_TRANSCRIPT =
  "project Niagara typescript Chai framework Chai do deploy material way 来自 Chai MongoDB Atlassian common。";

function configuration(id: string, overrides: Partial<EvalConfiguration> = {}): EvalConfiguration {
  // Splitting the id for a providerId default is a test-fixture shortcut only
  // — production code must not do this (see `ConfigurationDescriptor` in
  // apps/backend/src/asr.ts): the real providerId always comes from the server.
  return { id, label: id, providerId: id.split("/")[0]!, configured: true, ...overrides };
}

/** PCM stand-in: `seconds` of silence, cut into 256-byte worklet chunks. */
function recordedChunks(seconds: number): ArrayBuffer[] {
  const chunks: ArrayBuffer[] = [];
  for (let i = 0; i < (seconds * 32000) / 256; i++) chunks.push(new ArrayBuffer(256));
  return chunks;
}

/**
 * A run driven entirely by the test: no sockets, no clock. `tick()` advances
 * the paced replay exactly one 100 ms frame, so a test asserts on pacing by
 * counting ticks rather than by waiting.
 */
function createHarness(
  configurations: readonly EvalConfiguration[],
  chunks: readonly ArrayBuffer[],
  primaryConfigurationId?: string,
) {
  const pending = new Map<number, () => void>();
  const scheduledIntervals: number[] = [];
  let nextHandle = 1;
  const timers: EvalTimers = {
    setTimeout(callback, ms) {
      scheduledIntervals.push(ms);
      const handle = nextHandle++;
      pending.set(handle, callback);
      return handle;
    },
    clearTimeout(handle) {
      pending.delete(handle);
    },
  };

  const sockets = new Map<
    string,
    {
      handlers: EvalSocketHandlers;
      sent: (ArrayBuffer | string)[];
      closes: number;
    }
  >();

  const run = startEvalRun({
    configurations,
    primaryConfigurationId,
    chunks,
    timers,
    connect(configurationId, handlers) {
      const entry = { handlers, sent: [] as (ArrayBuffer | string)[], closes: 0 };
      sockets.set(configurationId, entry);
      return {
        send: (data) => void entry.sent.push(data),
        close: () => void entry.closes++,
      };
    },
  });

  return {
    run,
    sockets,
    scheduledIntervals,
    emit(configurationId: string, event: EvalServerEvent) {
      sockets.get(configurationId)!.handlers.onEvent(event);
    },
    hangUp(configurationId: string, code = 1006, reason = "") {
      sockets.get(configurationId)!.handlers.onClose({ code, reason });
    },
    /** Fire every timer currently due — one frame of paced replay. */
    tick() {
      const due = [...pending.entries()];
      pending.clear();
      for (const [, callback] of due) callback();
    },
    row(configurationId: string): EvalRow {
      return run.$rows.get().find((r) => r.configurationId === configurationId)!;
    },
    audioFrames(configurationId: string) {
      return sockets.get(configurationId)!.sent.filter((data) => data instanceof ArrayBuffer);
    },
  };
}

// --- Re-cutting the capture into wire frames ---

test("re-cuts 256-byte worklet chunks into 100 ms frames", () => {
  // 1 second of audio: 125 worklet chunks in, 10 frames out.
  const frames = toPacedFrames(recordedChunks(1));

  expect(frames).toHaveLength(10);
  expect(frames.every((frame) => frame.byteLength === EVAL_FRAME_BYTES)).toBe(true);
});

test("keeps a short tail rather than padding or dropping it", () => {
  const frames = toPacedFrames([new ArrayBuffer(EVAL_FRAME_BYTES + 100)]);

  expect(frames.map((frame) => frame.byteLength)).toEqual([EVAL_FRAME_BYTES, 100]);
});

test("preserves the audio's bytes and their order across the re-cut", () => {
  const first = new Uint8Array([1, 2, 3]);
  const second = new Uint8Array([4, 5, 6, 7]);
  const frames = toPacedFrames([first.buffer, second.buffer], 3);

  expect(frames.map((frame) => [...new Uint8Array(frame)])).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
});

test("an empty recording yields no frames", () => {
  expect(toPacedFrames([])).toEqual([]);
});

test("a run takes the clip's own duration, however many configurations it has", () => {
  const chunks = recordedChunks(9);
  const frames = toPacedFrames(chunks);

  expect(evalDurationSeconds(chunks)).toBe(9);
  // Parallel connections, so this is the wall-clock for the whole run — not
  // 9 s x the number of rows.
  expect((frames.length * EVAL_FRAME_INTERVAL_MS) / 1000).toBe(9);
});

// --- The socket URL ---

test("percent-encodes the + in a configuration id", () => {
  const url = buildEvalSocketUrl({
    backendUrl: "https://api.example.com",
    accessToken: "tok",
    configurationId: QWEN_GROQ,
  });

  // The whole point: a literal + would arrive at the server as a space.
  expect(url).toContain("configuration=qwen%2Fqwen3-asr-flash-realtime%2Bgroq");
  expect(new URL(url).searchParams.get("configuration")).toBe(QWEN_GROQ);
});

test("upgrades the backend's scheme to a websocket one", () => {
  const secure = buildEvalSocketUrl({
    backendUrl: "https://api.example.com/",
    accessToken: "tok",
    configurationId: QWEN,
  });
  const insecure = buildEvalSocketUrl({
    backendUrl: "http://localhost:8787/",
    accessToken: "tok",
    configurationId: QWEN,
  });

  expect(secure.startsWith("wss://api.example.com/asr/eval?")).toBe(true);
  expect(insecure.startsWith("ws://localhost:8787/asr/eval?")).toBe(true);
});

// --- Per-provider pacing ---

test("a provider not confirmed fast-dump-safe defaults to realtime", () => {
  expect(evalFrameIntervalMs("future-vendor")).toBe(EVAL_FRAME_INTERVAL_MS);
});

test("providers confirmed by testdata/OBSERVATIONS.md skip the pacing delay", () => {
  expect(evalFrameIntervalMs("qwen")).toBe(0);
  expect(evalFrameIntervalMs("qwen-omni")).toBe(0);
  expect(evalFrameIntervalMs("byteplus")).toBe(0);
  expect(evalFrameIntervalMs("mock")).toBe(0);
});

test("replays one frame per tick and never dumps the buffer", () => {
  const harness = createHarness([configuration(SLOW_VENDOR)], recordedChunks(1));

  harness.emit(SLOW_VENDOR, { type: "ready", configurationId: SLOW_VENDOR });
  // `ready` sends the first frame; nothing more until the clock moves.
  expect(harness.audioFrames(SLOW_VENDOR)).toHaveLength(1);

  harness.tick();
  expect(harness.audioFrames(SLOW_VENDOR)).toHaveLength(2);

  harness.tick();
  expect(harness.audioFrames(SLOW_VENDOR)).toHaveLength(3);

  // Every frame sent schedules its follow-up at the untested provider's default.
  expect(harness.scheduledIntervals).toEqual([
    EVAL_FRAME_INTERVAL_MS,
    EVAL_FRAME_INTERVAL_MS,
    EVAL_FRAME_INTERVAL_MS,
  ]);
});

test("a row on a fast-dump-confirmed provider is paced with no delay", () => {
  const harness = createHarness([configuration(QWEN)], recordedChunks(1));

  harness.emit(QWEN, { type: "ready", configurationId: QWEN });
  harness.tick();

  expect(harness.audioFrames(QWEN)).toHaveLength(2);
  expect(harness.scheduledIntervals).toEqual([0, 0]);
});

test("sends no audio before the server says it is ready", () => {
  const harness = createHarness([configuration(QWEN)], recordedChunks(1));

  harness.tick();

  expect(harness.audioFrames(QWEN)).toHaveLength(0);
  expect(harness.row(QWEN).status).toBe("connecting");
});

test("stops after the last frame and asks the vendor to finish", () => {
  // 0.2 s is exactly two 100 ms frames; the ticks beyond that must send nothing.
  const harness = createHarness([configuration(QWEN)], recordedChunks(0.2));

  harness.emit(QWEN, { type: "ready", configurationId: QWEN });
  for (let i = 0; i < 5; i++) harness.tick();

  expect(harness.audioFrames(QWEN)).toHaveLength(2);
  expect(harness.sockets.get(QWEN)!.sent.at(-1)).toBe(JSON.stringify({ type: "stop" }));
  expect(harness.row(QWEN).status).toBe("finishing");
});

test("a late connection still hears its audio at its own pace rather than catching up", () => {
  const harness = createHarness(
    [configuration(QWEN), configuration(SLOW_VENDOR)],
    recordedChunks(1),
  );

  harness.emit(QWEN, { type: "ready", configurationId: QWEN });
  harness.tick();
  harness.tick();
  // The slow vendor only gets going three frames in.
  harness.emit(SLOW_VENDOR, { type: "ready", configurationId: SLOW_VENDOR });

  expect(harness.audioFrames(QWEN)).toHaveLength(3);
  // Not 3 — pacing is per socket, from its own ready. A burst is the dump a
  // realtime-only provider cannot tolerate.
  expect(harness.audioFrames(SLOW_VENDOR)).toHaveLength(1);

  harness.tick();
  expect(harness.audioFrames(QWEN)).toHaveLength(4);
  expect(harness.audioFrames(SLOW_VENDOR)).toHaveLength(2);
});

test("progress tracks the clip rather than the number of rows", () => {
  const harness = createHarness(
    [configuration(QWEN), configuration(SLOW_VENDOR)],
    recordedChunks(1),
  );

  expect(harness.run.frameCount).toBe(10);
  expect(harness.run.$progress.get()).toBe(0);

  harness.emit(QWEN, { type: "ready", configurationId: QWEN });
  harness.emit(SLOW_VENDOR, { type: "ready", configurationId: SLOW_VENDOR });
  for (let i = 0; i < 4; i++) harness.tick();

  expect(harness.run.$progress.get()).toBeCloseTo(0.5);
});

// --- Streaming partials ---

test("a row streams its interim text as it arrives", () => {
  const harness = createHarness([configuration(QWEN)], recordedChunks(0.2));

  harness.emit(QWEN, { type: "ready", configurationId: QWEN });
  harness.emit(QWEN, { type: "partial", text: "project นี้" });
  expect(harness.row(QWEN).partial).toBe("project นี้");

  harness.emit(QWEN, { type: "partial", text: "project นี้เขียนด้วย" });
  expect(harness.row(QWEN).partial).toBe("project นี้เขียนด้วย");

  harness.emit(QWEN, { type: "final", text: QWEN_TRANSCRIPT });
  harness.emit(QWEN, { type: "end" });

  // The final supersedes the interim text rather than sitting under it.
  expect(harness.row(QWEN).partial).toBe("");
  expect(harness.row(QWEN).final).toBe(QWEN_TRANSCRIPT);
  expect(harness.row(QWEN).status).toBe("done");
});

test("a row that never streams a partial still finishes normally", () => {
  // A buffering batch adapter emits nothing until the audio stops. The run must
  // not read that silence as a stall.
  const harness = createHarness([configuration(BYTEPLUS)], recordedChunks(0.2));

  harness.emit(BYTEPLUS, { type: "ready", configurationId: BYTEPLUS });
  for (let i = 0; i < 3; i++) harness.tick();

  expect(harness.row(BYTEPLUS).partial).toBe("");
  expect(harness.row(BYTEPLUS).status).toBe("finishing");

  harness.emit(BYTEPLUS, { type: "final", text: BYTEPLUS_TRANSCRIPT });
  harness.emit(BYTEPLUS, { type: "end" });

  expect(harness.row(BYTEPLUS).final).toBe(BYTEPLUS_TRANSCRIPT);
  expect(canWinEval(harness.row(BYTEPLUS))).toBe(true);
});

// --- Rows that go wrong ---

test("an unconfigured configuration is shown, not connected to", () => {
  const harness = createHarness(
    [configuration(QWEN), configuration(BYTEPLUS, { configured: false })],
    recordedChunks(0.2),
  );

  // Listed so the gap is visible; the server itself says not to fan out to it.
  expect(harness.sockets.has(BYTEPLUS)).toBe(false);
  expect(harness.row(BYTEPLUS).status).toBe("skipped");
  expect(harness.row(BYTEPLUS).error).toBe("Not configured on this server");
  expect(canWinEval(harness.row(BYTEPLUS))).toBe(false);
  expect(harness.sockets.has(QWEN)).toBe(true);
});

test("a vendor error fails only its own row", () => {
  const harness = createHarness(
    [configuration(QWEN), configuration(BYTEPLUS)],
    recordedChunks(0.2),
  );

  harness.emit(QWEN, { type: "ready", configurationId: QWEN });
  harness.emit(BYTEPLUS, { type: "ready", configurationId: BYTEPLUS });
  harness.emit(BYTEPLUS, { type: "error", message: "vendor rejected the stream" });

  expect(harness.row(BYTEPLUS).status).toBe("failed");
  expect(harness.row(BYTEPLUS).error).toBe("vendor rejected the stream");
  expect(canWinEval(harness.row(BYTEPLUS))).toBe(false);
  // The eval carries on without it.
  expect(harness.row(QWEN).status).toBe("listening");
  harness.tick();
  expect(harness.audioFrames(QWEN)).toHaveLength(2);
});

test("a failed row stops being paced", () => {
  const harness = createHarness([configuration(QWEN)], recordedChunks(1));

  harness.emit(QWEN, { type: "ready", configurationId: QWEN });
  harness.emit(QWEN, { type: "error", message: "boom" });
  harness.tick();
  harness.tick();

  // No point paying for audio nobody is listening to.
  expect(harness.audioFrames(QWEN)).toHaveLength(1);
});

test("a socket that shuts without an end is a failure, and says why", () => {
  const harness = createHarness([configuration(QWEN)], recordedChunks(0.2));

  harness.hangUp(QWEN, 1011, "DASHSCOPE_API_KEY not configured");

  expect(harness.row(QWEN).status).toBe("failed");
  // The close reason is the server's diagnosis; the code is not.
  expect(harness.row(QWEN).error).toBe("DASHSCOPE_API_KEY not configured");
});

test("a close with no reason still names the failure", () => {
  const harness = createHarness([configuration(QWEN)], recordedChunks(0.2));

  harness.hangUp(QWEN, 1006, "");

  expect(harness.row(QWEN).error).toBe("Connection closed (1006)");
});

test("a normal close after end does not overwrite the result", () => {
  const harness = createHarness([configuration(QWEN)], recordedChunks(0.2));

  harness.emit(QWEN, { type: "ready", configurationId: QWEN });
  harness.emit(QWEN, { type: "final", text: QWEN_TRANSCRIPT });
  harness.emit(QWEN, { type: "end" });
  harness.hangUp(QWEN, 1000, "done");

  expect(harness.row(QWEN).status).toBe("done");
  expect(harness.row(QWEN).final).toBe(QWEN_TRANSCRIPT);
});

// --- Settling, cost, and the primary ---

test("the run settles only once every row has stopped changing", () => {
  const harness = createHarness(
    [configuration(QWEN), configuration(BYTEPLUS, { configured: false })],
    recordedChunks(0.2),
  );

  expect(harness.run.$settled.get()).toBe(false);

  harness.emit(QWEN, { type: "ready", configurationId: QWEN });
  harness.emit(QWEN, { type: "final", text: QWEN_TRANSCRIPT });
  harness.emit(QWEN, { type: "end" });

  // A skipped row is already as settled as it will ever be.
  expect(harness.run.$settled.get()).toBe(true);
});

test("marks the row whose answer a winner would replace", () => {
  const harness = createHarness(
    [configuration(QWEN), configuration(QWEN_GROQ)],
    recordedChunks(0.2),
    QWEN_GROQ,
  );

  expect(harness.row(QWEN).isPrimary).toBe(false);
  // The primary is one candidate among the rest, not a special case.
  expect(harness.row(QWEN_GROQ).isPrimary).toBe(true);
});

test("accumulates usage across records and totals it as cost", () => {
  const harness = createHarness([configuration(QWEN)], recordedChunks(0.2));

  harness.emit(QWEN, { type: "ready", configurationId: QWEN });
  harness.emit(QWEN, { type: "usage", records: [{ sku: "asr", unitPrice: 0.0001, quantity: 10 }] });
  harness.emit(QWEN, {
    type: "usage",
    records: [{ sku: "groq", unitPrice: 0.00002, quantity: 50 }],
  });

  expect(harness.row(QWEN).usage).toHaveLength(2);
  expect(evalRowCost(harness.row(QWEN))).toBeCloseTo(0.002);
});

test("a row with no transcript cannot win", () => {
  const harness = createHarness([configuration(QWEN)], recordedChunks(0.2));

  harness.emit(QWEN, { type: "ready", configurationId: QWEN });
  harness.emit(QWEN, { type: "end" });

  expect(harness.row(QWEN).status).toBe("done");
  expect(canWinEval(harness.row(QWEN))).toBe(false);
});

// --- Cancelling ---

test("cancelling closes every socket and stops the replay", () => {
  const harness = createHarness([configuration(QWEN), configuration(BYTEPLUS)], recordedChunks(1));

  harness.emit(QWEN, { type: "ready", configurationId: QWEN });
  harness.emit(BYTEPLUS, { type: "ready", configurationId: BYTEPLUS });
  harness.run.cancel();
  harness.tick();

  expect(harness.sockets.get(QWEN)!.closes).toBe(1);
  expect(harness.sockets.get(BYTEPLUS)!.closes).toBe(1);
  expect(harness.audioFrames(QWEN)).toHaveLength(1);
  expect(harness.audioFrames(BYTEPLUS)).toHaveLength(1);
});

test("cancelling twice closes each socket once", () => {
  const harness = createHarness([configuration(QWEN)], recordedChunks(1));

  harness.run.cancel();
  harness.run.cancel();

  expect(harness.sockets.get(QWEN)!.closes).toBe(1);
});

test("events arriving after a cancel are ignored", () => {
  const harness = createHarness([configuration(QWEN)], recordedChunks(1));

  harness.emit(QWEN, { type: "ready", configurationId: QWEN });
  harness.run.cancel();
  harness.emit(QWEN, { type: "final", text: QWEN_TRANSCRIPT });

  expect(harness.row(QWEN).final).toBeNull();
});
