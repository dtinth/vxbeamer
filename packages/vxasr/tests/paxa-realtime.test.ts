import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { expect, test } from "vite-plus/test";
import {
  createDefaultConfigurationCatalogue,
  createPaxaRealtimeProvider,
  PAXA_REALTIME_DEFAULT_MODEL,
} from "../src/index.ts";
import { run, trackVendors } from "./streamingSessionHarness.ts";

/**
 * A local stand-in for Paxa's realtime endpoint, speaking the protocol as it
 * was observed live (dtinth/vxbeamer#86): a `start` frame, raw binary audio,
 * `{"type":"end"}`, then per-turn `transcript` frames and one `done`. What
 * the fake sends after `end` is a script, so each test can play the turn
 * sequence it needs. No network.
 */
interface FakeVendor {
  readonly baseUrl: string;
  readonly headerAuthorization: () => string | undefined;
  readonly start: () => Record<string, any> | undefined;
  readonly audio: () => Buffer;
  readonly events: () => readonly string[];
  close(): Promise<void>;
}

type Script = (ws: WebSocket) => void;

const send = (ws: WebSocket, frame: object) => ws.send(JSON.stringify(frame));

const transcript = (turn: number, text: string, isFinal: boolean) => ({
  type: "transcript",
  turn,
  is_final: isFinal,
  text,
  start: 0,
  end: 1,
});

const done = (seconds: number, turns: number) => ({
  type: "done",
  total_seconds: seconds,
  turns,
  total_credits: 1,
});

async function startFakeVendor(afterEnd: Script): Promise<FakeVendor> {
  const server: Server = createServer();
  const wss = new WebSocketServer({ server });

  let headerAuthorization: string | undefined;
  let start: Record<string, any> | undefined;
  let audio = Buffer.alloc(0);
  const events: string[] = [];

  wss.on("connection", (ws: WebSocket, request) => {
    headerAuthorization = request.headers.authorization;
    ws.on("message", (raw: Buffer, isBinary: boolean) => {
      if (isBinary) {
        audio = Buffer.concat([audio, raw]);
        if (events.at(-1) !== "audio") events.push("audio");
        return;
      }
      const data = JSON.parse(raw.toString());
      events.push(data.type);
      if (data.type === "start") {
        start = data;
        send(ws, { type: "started", connection: "fake", model: data.model });
      } else if (data.type === "end") {
        afterEnd(ws);
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `ws://127.0.0.1:${port}/v1/stt/live`,
    headerAuthorization: () => headerAuthorization,
    start: () => start,
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
const provider = (vendor: FakeVendor, convention?: "spoken" | "written") =>
  createPaxaRealtimeProvider({ apiKey: "test-key", baseUrl: vendor.baseUrl, convention });

test("authenticates by header, sends start, every audio byte, then end", async () => {
  const vendor = await withVendor(() => startFakeVendor((ws) => send(ws, done(0.2, 0))));
  const clip = Buffer.alloc(6500, 7); // two full 3200-byte chunks and a 100-byte tail

  await run(provider(vendor), clip);

  expect(vendor.headerAuthorization()).toBe("Bearer test-key");
  expect(vendor.start()).toEqual({
    type: "start",
    model: PAXA_REALTIME_DEFAULT_MODEL,
    audio: { encoding: "pcm_s16le", sample_rate: 16000 },
  });
  expect(vendor.audio().equals(clip)).toBe(true);
  expect(vendor.events()).toEqual(["start", "audio", "end"]);
});

test("passes the convention in the start frame only when one is set", async () => {
  const vendor = await withVendor(() => startFakeVendor((ws) => send(ws, done(0.2, 0))));

  await run(provider(vendor, "written"), Buffer.alloc(3200));

  expect(vendor.start()?.convention).toBe("written");
});

test("one turn: partials as they come, then the final when done arrives", async () => {
  const vendor = await withVendor(() =>
    startFakeVendor((ws) => {
      send(ws, transcript(1, "โปรเจกต์นี้", false));
      send(ws, transcript(1, "โปรเจกต์นี้เขียนด้วย TypeScript", true));
      send(ws, done(9.218, 1));
    }),
  );

  const outcome = await run(provider(vendor), Buffer.alloc(3200));

  expect(outcome.error).toBeUndefined();
  expect(outcome.partials[0]).toBe("โปรเจกต์นี้");
  expect(outcome.text).toBe("โปรเจกต์นี้เขียนด้วย TypeScript");
});

test("a pause makes a second turn, and the first turn's text is kept", async () => {
  const vendor = await withVendor(() =>
    startFakeVendor((ws) => {
      send(ws, transcript(1, "ประโยคแรก", true));
      send(ws, transcript(2, "ประโยค", false));
      send(ws, transcript(2, "ประโยคที่สอง", true));
      send(ws, done(21.4, 2));
    }),
  );

  const outcome = await run(provider(vendor), Buffer.alloc(3200));

  // While turn 2 is in progress, turn 1 is still on screen.
  expect(outcome.partials).toContain("ประโยคแรก ประโยค");
  expect(outcome.text).toBe("ประโยคแรก ประโยคที่สอง");
});

test("silence ends with an empty final, not a hang", async () => {
  const vendor = await withVendor(() => startFakeVendor((ws) => send(ws, done(3, 0))));

  const outcome = await run(provider(vendor), Buffer.alloc(3200));

  expect(outcome.error).toBeUndefined();
  expect(outcome.text).toBe("");
});

test("usage is the whole connection's seconds, at 12.5 credits a minute", async () => {
  const vendor = await withVendor(() =>
    startFakeVendor((ws) => {
      send(ws, transcript(1, "x", true));
      send(ws, done(21.436, 1));
    }),
  );

  const outcome = await run(provider(vendor), Buffer.alloc(3200));

  expect(outcome.usage).toHaveLength(1);
  const [record] = outcome.usage;
  expect(record?.sku).toBe(`paxa:${PAXA_REALTIME_DEFAULT_MODEL}:seconds`);
  expect(record?.quantity).toBe(21.436);
  // An hour: 750 credits at ฿329 per 10,000, at ฿35/USD ≈ $0.705.
  expect((record?.unitPrice ?? 0) * 3600).toBeCloseTo(0.705, 3);
});

test("a turn error fails the session", async () => {
  const vendor = await withVendor(() =>
    startFakeVendor((ws) => send(ws, { type: "error", turn: 1 })),
  );

  const outcome = await run(provider(vendor), Buffer.alloc(3200));

  expect(outcome.error?.message).toContain("turn 1");
});

test("the server closing before done fails the session instead of hanging", async () => {
  const vendor = await withVendor(() =>
    startFakeVendor((ws) => {
      send(ws, transcript(1, "x", true));
      ws.close(1011, "oops");
    }),
  );

  const outcome = await run(provider(vendor), Buffer.alloc(3200));

  expect(outcome.error?.message).toContain("closed before done");
});

test("the realtime configuration is selectable and declares a fast dump", () => {
  const configuration = createDefaultConfigurationCatalogue()
    .list()
    .find((c) => c.id === `paxa/${PAXA_REALTIME_DEFAULT_MODEL}`);

  expect(configuration).toBeDefined();
  expect(configuration?.supportsFastDump).toBe(true);
});
