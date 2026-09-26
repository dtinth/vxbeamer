import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { expect, test } from "vite-plus/test";
import {
  createDefaultConfigurationCatalogue,
  createDefaultProviderRegistry,
  createGeminiLiveProvider,
  GEMINI_LIVE_DEFAULT_MODEL,
} from "../src/index.ts";
import { run, trackVendors } from "./streamingSessionHarness.ts";

/**
 * A local stand-in for the Gemini Live API in push-to-talk mode, speaking the
 * protocol as it was observed live (dtinth/vxbeamer#86): `setup`, then
 * `activityStart`, base64 audio in `realtimeInput` frames, `activityEnd`; the
 * server answers `setupComplete`, and after `activityEnd` plays a script,
 * which normally ends with `voiceActivity: ACTIVITY_END`. No network.
 */
interface FakeVendor {
  readonly baseUrl: string;
  readonly requestUrl: () => string | undefined;
  readonly setup: () => Record<string, any> | undefined;
  readonly audio: () => Buffer;
  readonly events: () => readonly string[];
  close(): Promise<void>;
}

type Script = (ws: WebSocket) => void;

const send = (ws: WebSocket, frame: object) => ws.send(JSON.stringify(frame));
const interim = (text: string) => ({ serverContent: { interimInputTranscription: { text } } });
const final = (text: string) => ({ serverContent: { inputTranscription: { text } } });
const activityEnd = { serverContent: {}, voiceActivity: { type: "ACTIVITY_END" } };

async function startFakeVendor(afterEnd: Script, whileRecording?: Script): Promise<FakeVendor> {
  const server: Server = createServer();
  const wss = new WebSocketServer({ server });

  let requestUrl: string | undefined;
  let setup: Record<string, any> | undefined;
  let audio = Buffer.alloc(0);
  const events: string[] = [];

  wss.on("connection", (ws: WebSocket, request) => {
    requestUrl = request.url;
    ws.on("message", (raw: Buffer) => {
      const data = JSON.parse(raw.toString());
      if (data.setup) {
        setup = data.setup;
        events.push("setup");
        send(ws, { setupComplete: {} });
        return;
      }
      const input = data.realtimeInput ?? {};
      if (input.audio) {
        audio = Buffer.concat([audio, Buffer.from(input.audio.data, "base64")]);
        if (events.at(-1) !== "audio") {
          events.push("audio");
          whileRecording?.(ws);
        }
      } else if (input.activityStart) {
        events.push("activityStart");
        send(ws, { serverContent: {}, voiceActivity: { type: "ACTIVITY_START" } });
      } else if (input.activityEnd) {
        events.push("activityEnd");
        afterEnd(ws);
      } else {
        events.push(JSON.stringify(input));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `ws://127.0.0.1:${port}/ws/live`,
    requestUrl: () => requestUrl,
    setup: () => setup,
    audio: () => audio,
    events: () => events,
    close: () =>
      new Promise((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => server.close(() => resolve()));
      }),
  };
}

const { withVendor } = trackVendors<FakeVendor>();
const provider = (vendor: FakeVendor, endTimeoutMs?: number) =>
  createGeminiLiveProvider({ apiKey: "test key", baseUrl: vendor.baseUrl, endTimeoutMs });

test("key in the URL; setup in push-to-talk and smart mode; activityStart, audio, activityEnd", async () => {
  const vendor = await withVendor(() => startFakeVendor((ws) => send(ws, activityEnd)));
  const clip = Buffer.alloc(6500, 7); // two full 3200-byte chunks and a 100-byte tail

  await run(provider(vendor), clip);

  expect(vendor.requestUrl()).toBe("/ws/live?key=test%20key");
  expect(vendor.setup()).toEqual({
    model: `models/${GEMINI_LIVE_DEFAULT_MODEL}`,
    generationConfig: { responseModalities: ["TEXT"] },
    realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
    inputAudioTranscription: { mode: "SMART" },
  });
  expect(vendor.events()).toEqual(["setup", "activityStart", "audio", "activityEnd"]);
  expect(vendor.audio().equals(clip)).toBe(true);
});

test("partials while recording, then the final, ending at ACTIVITY_END", async () => {
  const vendor = await withVendor(() =>
    startFakeVendor(
      (ws) => {
        send(ws, final("โปรเจกต์นี้เขียนด้วยภาษา TypeScript"));
        send(ws, { serverContent: { generationComplete: true } });
        send(ws, activityEnd);
      },
      (ws) => send(ws, interim("โปรเจกต์ นี้")),
    ),
  );

  const outcome = await run(provider(vendor), Buffer.alloc(3200));

  expect(outcome.error).toBeUndefined();
  expect(outcome.partials[0]).toBe("โปรเจกต์ นี้");
  expect(outcome.text).toBe("โปรเจกต์นี้เขียนด้วยภาษา TypeScript");
});

test("the session does not end at the final, only at ACTIVITY_END", async () => {
  // If the vendor ever sends two finals, the second must not be lost.
  const vendor = await withVendor(() =>
    startFakeVendor((ws) => {
      send(ws, final("ประโยคแรก"));
      send(ws, final("ประโยคที่สอง"));
      send(ws, activityEnd);
    }),
  );

  const outcome = await run(provider(vendor), Buffer.alloc(3200));

  expect(outcome.text).toBe("ประโยคแรก ประโยคที่สอง");
});

test("silence: no final, but ACTIVITY_END still ends it with an empty transcript", async () => {
  const vendor = await withVendor(() => startFakeVendor((ws) => send(ws, activityEnd)));

  const outcome = await run(provider(vendor), Buffer.alloc(3200));

  expect(outcome.error).toBeUndefined();
  expect(outcome.text).toBe("");
});

test("usage is the audio sent, at $0.009 a minute", async () => {
  const vendor = await withVendor(() => startFakeVendor((ws) => send(ws, activityEnd)));

  const outcome = await run(provider(vendor), Buffer.alloc(32000 * 2)); // 2 s

  expect(outcome.usage).toHaveLength(1);
  const [record] = outcome.usage;
  expect(record?.sku).toBe(`gemini:${GEMINI_LIVE_DEFAULT_MODEL}:seconds`);
  expect(record?.quantity).toBe(2);
  expect((record?.unitPrice ?? 0) * 60).toBeCloseTo(0.009, 6);
});

test("the server closing before ACTIVITY_END fails the session", async () => {
  const vendor = await withVendor(() =>
    startFakeVendor((ws) => {
      send(ws, final("x"));
      ws.close(1008, "quota");
    }),
  );

  const outcome = await run(provider(vendor), Buffer.alloc(3200));

  expect(outcome.error?.message).toContain("1008 quota");
});

test("no ACTIVITY_END at all fails the session after the timeout, instead of hanging", async () => {
  const vendor = await withVendor(() => startFakeVendor(() => {}));

  const outcome = await run(provider(vendor, 50), Buffer.alloc(3200));

  expect(outcome.error?.message).toContain("no end of activity");
});

test("the gemini provider needs GEMINI_API_KEY, and both Gemini configurations are offered", () => {
  expect(createDefaultProviderRegistry().get("gemini")?.missingConfig({})).toEqual([
    "GEMINI_API_KEY",
  ]);

  const ids = createDefaultConfigurationCatalogue()
    .list()
    .map((c) => c.id);
  expect(ids).toContain(`gemini/${GEMINI_LIVE_DEFAULT_MODEL}`);
  expect(ids).toContain("openrouter/google/gemini-3.5-transcribe");
});
