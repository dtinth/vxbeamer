import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { expect, test } from "vite-plus/test";
import { createIAppProvider } from "../src/index.ts";
import { MAX_BACKLOG_SECONDS } from "../src/providers/iapp.ts";
import { run, trackVendors } from "./streamingSessionHarness.ts";

/**
 * A local stand-in for iApp's realtime socket, speaking the protocol as
 * observed live: the client sends a JSON settings message first, the server
 * answers `ready`, audio is binary PCM, `end` (a text frame) finishes the
 * turn, and the server answers with finals and `done`.
 */
interface FakeVendor {
  readonly url: string;
  readonly request: () => { apiKey: string | undefined };
  readonly settings: () => Record<string, unknown> | undefined;
  readonly audioBytes: () => number;
  readonly audioBeforeReady: () => boolean;
  readonly ended: () => boolean;
  close(): Promise<void>;
}

interface VendorOptions {
  /** `partial` events sent when `end` arrives, before the finals. */
  partials?: { utterance: number; text: string }[];
  /** `final` events sent when `end` arrives, in this order. */
  finals?: { utterance: number; text: string }[];
  /** `audio_seconds` in `done`. */
  audioSeconds?: number;
  /** Send this error frame instead of finishing when `end` arrives. */
  error?: { code: string; message: string };
  /** Hang up when `end` arrives, without a word. */
  dropOnEnd?: boolean;
  readyDelayMs?: number;
}

async function startFakeVendor(options: VendorOptions = {}): Promise<FakeVendor> {
  const server: Server = createServer();
  const wss = new WebSocketServer({ server });

  let apiKey: string | undefined;
  let settings: Record<string, unknown> | undefined;
  let audioBytes = 0;
  let ready = false;
  let audioBeforeReady = false;
  let ended = false;

  wss.on("connection", (ws: WebSocket, request) => {
    const header = request.headers["apikey"];
    apiKey = Array.isArray(header) ? header[0] : header;

    ws.on("message", (raw: Buffer, isBinary: boolean) => {
      if (isBinary) {
        if (!ready) audioBeforeReady = true;
        audioBytes += raw.length;
        return;
      }
      const text = raw.toString();
      if (text === "end") {
        ended = true;
        if (options.dropOnEnd) {
          ws.terminate();
          return;
        }
        if (options.error) {
          ws.send(JSON.stringify({ type: "error", ...options.error }));
          ws.close();
          return;
        }
        for (const p of options.partials ?? []) {
          ws.send(JSON.stringify({ type: "partial", start: 0, ...p }));
        }
        for (const f of options.finals ?? []) {
          ws.send(JSON.stringify({ type: "final", start: 0, end: 1, model: "m", ...f }));
        }
        ws.send(
          JSON.stringify({
            type: "done",
            audio_seconds: options.audioSeconds ?? audioBytes / 32000,
            utterances: options.finals?.length ?? 0,
          }),
        );
        ws.close();
        return;
      }
      // The first text frame is the settings message.
      settings = JSON.parse(text);
      setTimeout(() => {
        ready = true;
        ws.send(JSON.stringify({ type: "ready", session_id: "s1" }));
      }, options.readyDelayMs ?? 20);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/realtime-v2`,
    request: () => ({ apiKey }),
    settings: () => settings,
    audioBytes: () => audioBytes,
    audioBeforeReady: () => audioBeforeReady,
    ended: () => ended,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => server.close(() => resolve()));
      }),
  };
}

const provider = (vendor: FakeVendor, extra: object = {}) =>
  createIAppProvider({ apiKey: "ik", url: vendor.url, ...extra });

const { withVendor: track } = trackVendors<FakeVendor>();

const audio = (seconds: number) => Buffer.alloc(Math.round(seconds * 32000));

test("sends the key as a header and the settings first, holds audio until ready, and returns the final", async () => {
  const vendor = await track(() =>
    startFakeVendor({
      partials: [{ utterance: 0, text: "สวัสดี" }],
      finals: [{ utterance: 0, text: "สวัสดีครับ" }],
      readyDelayMs: 60,
    }),
  );

  const outcome = await run(provider(vendor), audio(1));

  expect(outcome.error).toBeUndefined();
  expect(outcome.text).toBe("สวัสดีครับ");
  expect(vendor.request().apiKey).toBe("ik");
  expect(vendor.settings()).toEqual({
    language_code: "th",
    sample_rate: 16000,
    encoding: "pcm_s16le",
  });
  expect(vendor.audioBeforeReady()).toBe(false);
  expect(vendor.audioBytes()).toBe(32000);
  expect(vendor.ended()).toBe(true);
});

test("passes the latency and end-silence options on as the vendor's settings", async () => {
  const vendor = await track(() => startFakeVendor({ finals: [{ utterance: 0, text: "ก" }] }));

  await run(provider(vendor, { latencyMs: 320, endSilenceMs: 1200 }), audio(0.5));

  expect(vendor.settings()).toMatchObject({ latency_ms: 320, end_silence_ms: 1200 });
});

test("a partial shows the finals so far plus the running utterance, and a final replaces it", async () => {
  const vendor = await track(() =>
    startFakeVendor({
      partials: [
        { utterance: 0, text: "ก" },
        { utterance: 0, text: "กข" },
      ],
      finals: [{ utterance: 0, text: "กขค" }],
    }),
  );

  const outcome = await run(provider(vendor), audio(0.5));

  expect(outcome.partials).toEqual(["ก", "กข", "กขค"]);
  expect(outcome.text).toBe("กขค");
});

test("several sentences are joined in utterance order, with a space only where Latin meets text", async () => {
  const vendor = await track(() =>
    startFakeVendor({
      finals: [
        { utterance: 1, text: "ต่อไป" },
        { utterance: 0, text: "สวัสดี" },
        { utterance: 2, text: "ok" },
        { utterance: 3, text: "จบ" },
      ],
    }),
  );

  const outcome = await run(provider(vendor), audio(1));

  expect(outcome.text).toBe("สวัสดีต่อไป ok จบ");
});

test("reports the audio the vendor counted, at the configured price", async () => {
  const vendor = await track(() =>
    startFakeVendor({ finals: [{ utterance: 0, text: "ก" }], audioSeconds: 1.25 }),
  );

  const free = await run(provider(vendor), audio(1));
  expect(free.usage).toEqual([
    { sku: "iapp:chinda-asr-realtime-v1:seconds", unitPrice: 0, quantity: 1.25 },
  ]);

  const priced = await run(provider(vendor, { pricePerSecond: 0.001 }), audio(1));
  expect(priced.usage[0]?.unitPrice).toBe(0.001);
});

test("a vendor error frame fails the session with the code and message", async () => {
  const vendor = await track(() =>
    startFakeVendor({ error: { code: "BUSY", message: "all live sessions are in use" } }),
  );

  const outcome = await run(provider(vendor), audio(1));

  expect(outcome.error?.message).toBe("iApp BUSY: all live sessions are in use");
  expect(outcome.text).toBe("");
});

test("a socket dropped before done fails instead of waiting forever", async () => {
  const vendor = await track(() => startFakeVendor({ dropOnEnd: true }));

  const outcome = await run(provider(vendor), audio(1));

  expect(outcome.error).toBeDefined();
});

test("a recording with no speech ends cleanly with no text", async () => {
  const vendor = await track(() => startFakeVendor());

  const outcome = await run(provider(vendor), audio(0.5));

  expect(outcome.error).toBeUndefined();
  expect(outcome.text).toBe("");
});

test("a long recording sent at once is held back to the backlog limit instead of tripping TOO_FAST", async () => {
  const vendor = await track(() => startFakeVendor({ finals: [{ utterance: 0, text: "ก" }] }));
  const session = provider(vendor).createSession({});
  const limit = MAX_BACKLOG_SECONDS * 32000;

  for (let offset = 0; offset < 130 * 32000; offset += 3200) {
    session.sendAudio(audio(0.1));
  }
  session.finish();
  await new Promise((resolve) => setTimeout(resolve, 500));

  // Over the backlog limit nothing more has gone out yet (a little real time
  // has passed, so a little more than the limit is allowed), and `end` waits
  // for the rest.
  expect(vendor.audioBytes()).toBeGreaterThanOrEqual(limit);
  expect(vendor.audioBytes()).toBeLessThan(limit + 3 * 32000);
  expect(vendor.ended()).toBe(false);
  session.close();
});
