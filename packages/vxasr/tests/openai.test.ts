import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { expect, test } from "vite-plus/test";
import {
  createOpenAIProvider,
  createDefaultConfigurationCatalogue,
  createDefaultProviderRegistry,
} from "../src/index.ts";
import { run, trackVendors, type RunOutcome } from "./streamingSessionHarness.ts";

/**
 * A local stand-in for OpenAI's Realtime Transcription endpoint. Speaks just
 * enough of the protocol confirmed live against the real API
 * (dtinth/vxbeamer#86) to let a session complete: `session.update` /
 * `session.updated`, `input_audio_buffer.append`, `.commit`, and the
 * transcript deltas + completion event. No network.
 */
interface FakeVendor {
  readonly baseUrl: string;
  readonly intent: () => string | undefined;
  readonly authorization: () => string | undefined;
  /** The `session.update` payload's `session` object. */
  readonly session: () => Promise<Record<string, any>>;
  /** Every client event type, in order. */
  readonly events: () => readonly string[];
  /** Base64-decoded audio the adapter appended, concatenated (wire format, post-upsample). */
  readonly audio: () => Buffer;
  close(): Promise<void>;
}

const TRANSCRIPT = "โปรเจกต์นี้เขียนด้วยภาษา TypeScript";

async function startFakeVendor(
  options: { transcript?: string; error?: object; failed?: object } = {},
): Promise<FakeVendor> {
  const server: Server = createServer();
  const wss = new WebSocketServer({ server });

  let intent: string | undefined;
  let authorization: string | undefined;
  const events: string[] = [];
  let audio = Buffer.alloc(0);
  let resolveSession: (payload: Record<string, any>) => void;
  const session = new Promise<Record<string, any>>((resolve) => {
    resolveSession = resolve;
  });

  wss.on("connection", (ws: WebSocket, request) => {
    intent = new URL(request.url ?? "", "ws://localhost").searchParams.get("intent") ?? undefined;
    authorization = request.headers.authorization;
    ws.send(JSON.stringify({ type: "session.created" }));

    ws.on("message", (raw: Buffer) => {
      const data = JSON.parse(raw.toString());
      events.push(data.type);

      if (data.type === "session.update") {
        resolveSession(data.session);
        ws.send(JSON.stringify({ type: "session.updated" }));
      } else if (data.type === "input_audio_buffer.append") {
        audio = Buffer.concat([audio, Buffer.from(data.audio, "base64")]);
      } else if (data.type === "input_audio_buffer.commit") {
        if (options.error) {
          ws.send(JSON.stringify({ type: "error", ...options.error }));
          return;
        }
        if (options.failed) {
          ws.send(
            JSON.stringify({
              type: "conversation.item.input_audio_transcription.failed",
              ...options.failed,
            }),
          );
          return;
        }
        // Deltas are incremental fragments, not the running text — a fake that
        // sent whole strings would not catch a bug here.
        const text = options.transcript ?? TRANSCRIPT;
        const half = Math.floor(text.length / 2);
        ws.send(
          JSON.stringify({
            type: "conversation.item.input_audio_transcription.delta",
            delta: text.slice(0, half),
          }),
        );
        ws.send(
          JSON.stringify({
            type: "conversation.item.input_audio_transcription.delta",
            delta: text.slice(half),
          }),
        );
        ws.send(
          JSON.stringify({
            type: "conversation.item.input_audio_transcription.completed",
            transcript: text,
          }),
        );
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `ws://127.0.0.1:${port}`,
    intent: () => intent,
    authorization: () => authorization,
    session: () => session,
    events: () => events,
    audio: () => audio,
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
  return createOpenAIProvider({ apiKey: "test-key", baseUrl: vendor.baseUrl });
}

// --- The session is configured as a transcription session ---

test("the session is configured for transcription at the vendor's minimum sample rate", async () => {
  const vendor = await withVendor();

  await run(provider(vendor), Buffer.alloc(3200));

  const session = await vendor.session();
  expect(session.type).toBe("transcription");
  // The vendor rejects anything below 24 kHz — confirmed live, this app
  // captures at 16 kHz, so the adapter upsamples before sending.
  expect(session.audio.input.format).toEqual({ type: "audio/pcm", rate: 24000 });
  expect(session.audio.input.transcription).toEqual({ model: "gpt-live-transcribe" });
  // The recording decides when the turn ends, not a silence detector.
  expect(session.audio.input.turn_detection).toBe(null);
});

test("the connection uses the transcription intent and bearer auth", async () => {
  const vendor = await withVendor();

  await run(provider(vendor), Buffer.alloc(3200));

  expect(vendor.intent()).toBe("transcription");
  expect(vendor.authorization()).toBe("Bearer test-key");
});

// --- Audio is upsampled to what the vendor requires ---

test("audio sent over the wire is upsampled from 16kHz to 24kHz", async () => {
  const vendor = await withVendor();
  // 6400 bytes = 3200 samples at 16 kHz. At a 1.5x ratio that's ~4800 samples
  // on the wire — 4799 exactly, since a streaming resampler can't resolve the
  // very last input sample as a boundary without a follow-up that never
  // arrives (see ../src/resample.ts and resample.test.ts).
  const audio = Buffer.alloc(6400, 1);

  await run(provider(vendor), audio);

  expect(vendor.audio().length).toBe(9598);
});

// --- The turn is ended this protocol's way ---

test("a turn ends with a commit alone, never a response.create", async () => {
  const vendor = await withVendor();

  const outcome = await run(provider(vendor), Buffer.alloc(6400));

  expect(outcome.text).toBe(TRANSCRIPT);
  expect(vendor.events()).toEqual([
    "session.update",
    "input_audio_buffer.append",
    "input_audio_buffer.append",
    "input_audio_buffer.commit",
  ]);
  expect(vendor.events()).not.toContain("response.create");
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

// --- Reading the model's own output ---

test("deltas accumulate into the transcript rather than replacing it", async () => {
  const vendor = await withVendor({ transcript: "abcd" });

  const outcome = await run(provider(vendor), Buffer.alloc(3200));

  expect(outcome.partials).toEqual(["ab", "abcd"]);
  expect(outcome.text).toBe("abcd");
});

test("an error event fails the session", async () => {
  const vendor = await withVendor({ error: { error: { message: "nope" } } });

  const outcome = await run(provider(vendor), Buffer.alloc(3200));

  expect(outcome.error?.message).toContain("nope");
});

test("a transcription-failed event fails the session", async () => {
  const vendor = await withVendor({ failed: { error: { message: "could not transcribe" } } });

  const outcome = await run(provider(vendor), Buffer.alloc(3200));

  expect(outcome.error?.message).toContain("could not transcribe");
});

// --- Billing is per second of audio, on what we actually captured ---

test("usage is billed by seconds of the original 16kHz audio, not the upsampled wire bytes", async () => {
  const vendor = await withVendor();
  // 32000 bytes = 1 second at 16 kHz.
  const audio = Buffer.alloc(32000);

  const outcome = await run(provider(vendor), audio);

  expect(outcome.usage).toEqual([
    { sku: "openai:gpt-live-transcribe:seconds", unitPrice: 0.017 / 60, quantity: 1 },
  ]);
});

// --- The registry and catalogue ---

test("the provider needs OPENAI_API_KEY and defaults to gpt-live-transcribe", () => {
  const registry = createDefaultProviderRegistry();

  expect(registry.get("openai")?.missingConfig({})).toEqual(["OPENAI_API_KEY"]);
  expect(registry.get("openai")?.defaultModel).toBe("gpt-live-transcribe");
});

test("the openai configuration is offered raw, never enhanced", () => {
  const catalogue = createDefaultConfigurationCatalogue();

  const openai = catalogue.list().filter((c) => c.providerId === "openai");

  expect(openai.map((c) => c.id)).toEqual(["openai/gpt-live-transcribe"]);
  expect(openai[0]?.postProcessing).toEqual([]);
});
