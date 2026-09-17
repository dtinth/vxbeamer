import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { expect, test } from "vite-plus/test";
import {
  createMetaMuseProvider,
  createDefaultConfigurationCatalogue,
  createDefaultProviderRegistry,
} from "../src/index.ts";
import { run, trackVendors, type RunOutcome } from "./streamingSessionHarness.ts";

/**
 * A local stand-in for Meta's realtime speech-to-text endpoint. Speaks just
 * enough of the protocol confirmed against Meta's own docs
 * (https://dev.meta.ai/docs/api-reference/voice/realtime, dtinth/vxbeamer#86)
 * to let a session complete: the handshake JSON frame (auth travels here, not
 * an HTTP header), a `sessionId` ack with no `type` field, raw binary audio
 * frames with no envelope, and the `transcript`/`error` server frames. No
 * network.
 */
interface FakeVendor {
  readonly baseUrl: string;
  /** The HTTP `Authorization` header the connection arrived with, if any. */
  readonly headerAuthorization: () => string | undefined;
  /** The handshake JSON frame. */
  readonly handshake: () => Promise<Record<string, any>>;
  /** Audio bytes received as raw binary frames, concatenated. */
  readonly audio: () => Buffer;
  /** Every client event seen after the handshake: "audio" or a JSON `type`. */
  readonly events: () => readonly string[];
  close(): Promise<void>;
}

const TRANSCRIPT = "โปรเจกต์นี้เขียนด้วยภาษา TypeScript";

async function startFakeVendor(
  options: { transcript?: string; error?: object } = {},
): Promise<FakeVendor> {
  const server: Server = createServer();
  const wss = new WebSocketServer({ server });

  let headerAuthorization: string | undefined;
  const events: string[] = [];
  let audio = Buffer.alloc(0);
  let resolveHandshake: (payload: Record<string, any>) => void;
  const handshake = new Promise<Record<string, any>>((resolve) => {
    resolveHandshake = resolve;
  });
  let handshakeSeen = false;

  wss.on("connection", (ws: WebSocket, request) => {
    headerAuthorization = request.headers.authorization;

    ws.on("message", (raw: Buffer, isBinary: boolean) => {
      if (isBinary) {
        events.push("audio");
        audio = Buffer.concat([audio, raw]);
        return;
      }

      const data = JSON.parse(raw.toString());

      if (!handshakeSeen) {
        handshakeSeen = true;
        resolveHandshake(data);
        // The handshake ack: deliberately no `type` field, per the docs — the
        // adapter must skip this rather than mistake it for a server error/
        // transcript frame.
        ws.send(JSON.stringify({ sessionId: "fake-session" }));
        return;
      }

      events.push(data.type);

      if (data.type === "endStream") {
        if (options.error) {
          ws.send(JSON.stringify({ type: "error", ...options.error }));
          return;
        }
        // Partials are cumulative in this protocol (`partialMode`), not
        // incremental fragments — a fake that sent fragments would not catch
        // a bug that concatenated instead of replaced.
        const text = options.transcript ?? TRANSCRIPT;
        const half = Math.floor(text.length / 2);
        ws.send(
          JSON.stringify({ type: "transcript", transcript: text.slice(0, half), final: false }),
        );
        ws.send(JSON.stringify({ type: "transcript", transcript: text, final: true }));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `ws://127.0.0.1:${port}`,
    headerAuthorization: () => headerAuthorization,
    handshake: () => handshake,
    audio: () => audio,
    events: () => events,
    async close() {
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const { withVendor: track } = trackVendors<FakeVendor>();

async function withVendor(options: Parameters<typeof startFakeVendor>[0] = {}) {
  return track(() => startFakeVendor(options));
}

function provider(vendor: FakeVendor) {
  return createMetaMuseProvider({ apiKey: "test-key", baseUrl: vendor.baseUrl });
}

// --- Auth and handshake travel in the opening JSON frame, not an HTTP header ---

test("auth and session config travel in the handshake frame, not a header", async () => {
  const vendor = await withVendor();

  await run(provider(vendor), Buffer.alloc(3200));

  const handshake = await vendor.handshake();
  expect(handshake.authorization).toEqual({ accessToken: "Bearer test-key" });
  expect(handshake.audioEncoding).toBe("PCM_16KHZ");
  expect(handshake.model).toBe("muse-voice-transcribe-1.0");
  // The caller decides when a turn ends, not a server-side endpointer.
  expect(handshake.mode).toBe("PUSH_TO_TALK");
  // The docs say this endpoint ignores the Authorization header entirely —
  // confirming the adapter never relies on it.
  expect(vendor.headerAuthorization()).toBeUndefined();
});

// --- Audio is sent as raw binary frames, no envelope ---

test("audio is sent as raw binary frames, unmodified", async () => {
  const vendor = await withVendor();
  const audio = Buffer.alloc(6400, 1);

  await run(provider(vendor), audio);

  expect(vendor.audio()).toEqual(audio);
});

// --- The turn is ended this protocol's way ---

test("a turn ends with endStream, after any trailing sub-chunk audio", async () => {
  const vendor = await withVendor();

  const outcome = await run(provider(vendor), Buffer.alloc(6400));

  expect(outcome.text).toBe(TRANSCRIPT);
  expect(vendor.events()).toEqual(["audio", "audio", "endStream"]);
});

test("a clip that finishes before the socket opens is still transcribed", async () => {
  const vendor = await withVendor();
  const outcome = await new Promise<RunOutcome>((resolve) => {
    let text = "";
    const session = provider(vendor).createSession({
      onFinal: (final) => (text = final),
      onEnd: () => resolve({ text, partials: [], usage: [] }),
      onError: (error) => resolve({ text, partials: [], usage: [], error }),
    });
    session.sendAudio(Buffer.alloc(3200));
    session.finish();
  });

  expect(outcome.error).toBeUndefined();
  expect(outcome.text).toBe(TRANSCRIPT);
});

// --- The handshake ack has no `type` field and must be skipped, not mistaken ---

test("the untyped handshake ack does not surface as a partial or an error", async () => {
  const vendor = await withVendor({ transcript: "abcd" });

  const outcome = await run(provider(vendor), Buffer.alloc(3200));

  expect(outcome.error).toBeUndefined();
  expect(outcome.partials).toEqual(["ab"]);
});

// --- Reading the model's own output ---

test("partials are cumulative, not accumulated fragments", async () => {
  const vendor = await withVendor({ transcript: "abcd" });

  const outcome = await run(provider(vendor), Buffer.alloc(3200));

  expect(outcome.partials).toEqual(["ab"]);
  expect(outcome.text).toBe("abcd");
});

test("an error frame fails the session", async () => {
  const vendor = await withVendor({ error: { message: "nope", sessionId: "fake-session" } });

  const outcome = await run(provider(vendor), Buffer.alloc(3200));

  expect(outcome.error?.message).toContain("nope");
});

// --- Billing is per second of audio processed, at Meta's published rate ---

test("usage is billed by seconds at $0.18/hour", async () => {
  const vendor = await withVendor();
  // 32000 bytes = 1 second at 16 kHz 16-bit mono.
  const audio = Buffer.alloc(32000);

  const outcome = await run(provider(vendor), audio);

  expect(outcome.usage).toEqual([
    { sku: "meta:muse-voice-transcribe-1.0:seconds", unitPrice: 0.18 / 3600, quantity: 1 },
  ]);
});

// --- The registry and catalogue ---

test("the provider needs META_API_KEY and defaults to muse-voice-transcribe-1.0", () => {
  const registry = createDefaultProviderRegistry();

  expect(registry.get("meta")?.missingConfig({})).toEqual(["META_API_KEY"]);
  expect(registry.get("meta")?.defaultModel).toBe("muse-voice-transcribe-1.0");
});

test("the meta configuration is offered raw, never enhanced", () => {
  const catalogue = createDefaultConfigurationCatalogue();

  const meta = catalogue.list().filter((c) => c.providerId === "meta");

  expect(meta.map((c) => c.id)).toEqual(["meta/muse-voice-transcribe-1.0"]);
  expect(meta[0]?.postProcessing).toEqual([]);
});
