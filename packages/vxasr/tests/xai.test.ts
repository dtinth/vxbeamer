import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { expect, test } from "vite-plus/test";
import { createXaiProvider } from "../src/index.ts";
import { run, trackVendors } from "./streamingSessionHarness.ts";

/**
 * A local stand-in for xAI's streaming speech-to-text socket, speaking the
 * protocol as observed live: `transcript.created` first, binary audio frames,
 * `{"type":"audio.done"}`, `transcript.partial` events, and a
 * `transcript.done` whose `text` is EMPTY (that is what the real endpoint
 * does, so the adapter must not depend on it).
 */
interface PartialEvent {
  text: string;
  is_final?: boolean;
  speech_final?: boolean;
}

interface FakeVendor {
  readonly baseUrl: string;
  readonly request: () => { query: URLSearchParams; authorization: string | undefined };
  /** Bytes of audio received, and whether any arrived before `transcript.created` was sent. */
  readonly audioBytes: () => number;
  readonly audioBeforeCreated: () => boolean;
  readonly clientMessages: () => readonly string[];
  close(): Promise<void>;
}

interface VendorOptions {
  /** Sent when `audio.done` arrives, in order, before `transcript.done`. */
  partials?: PartialEvent[];
  duration?: number;
  /** Send this instead of `transcript.done`. */
  error?: object;
  /** Hang up on `audio.done` without `transcript.done`. */
  dropOnDone?: boolean;
  /** Delay before `transcript.created`, so audio is ready first. */
  createdDelayMs?: number;
}

async function startFakeVendor(options: VendorOptions = {}): Promise<FakeVendor> {
  const server: Server = createServer();
  const wss = new WebSocketServer({ server });

  let query = new URLSearchParams();
  let authorization: string | undefined;
  let audioBytes = 0;
  let created = false;
  let audioBeforeCreated = false;
  const clientMessages: string[] = [];

  wss.on("connection", (ws: WebSocket, request) => {
    query = new URL(request.url ?? "", "ws://localhost").searchParams;
    authorization = request.headers.authorization;

    setTimeout(() => {
      created = true;
      ws.send(JSON.stringify({ type: "transcript.created", id: "t1" }));
    }, options.createdDelayMs ?? 20);

    ws.on("message", (raw: Buffer, isBinary: boolean) => {
      if (isBinary) {
        audioBytes += raw.length;
        if (!created) audioBeforeCreated = true;
        return;
      }
      const message = JSON.parse(raw.toString());
      clientMessages.push(message.type);
      if (message.type !== "audio.done") return;
      if (options.dropOnDone) {
        ws.terminate();
        return;
      }
      for (const partial of options.partials ?? []) {
        ws.send(
          JSON.stringify({
            type: "transcript.partial",
            is_final: false,
            speech_final: false,
            ...partial,
          }),
        );
      }
      if (options.error) {
        ws.send(JSON.stringify({ type: "error", ...options.error }));
        return;
      }
      ws.send(
        JSON.stringify({
          type: "transcript.done",
          text: "",
          duration: options.duration ?? 0.2,
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `ws://127.0.0.1:${port}/v1/stt`,
    request: () => ({ query, authorization }),
    audioBytes: () => audioBytes,
    audioBeforeCreated: () => audioBeforeCreated,
    clientMessages: () => clientMessages,
    async close() {
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const { withVendor: track } = trackVendors<FakeVendor>();

async function withVendor(options: VendorOptions = {}) {
  return track(() => startFakeVendor(options));
}

function provider(vendor: FakeVendor) {
  return createXaiProvider({ apiKey: "test-key", baseUrl: vendor.baseUrl });
}

// --- Connection ---

test("the connection is configured in the query string, with bearer auth", async () => {
  const vendor = await withVendor();

  await run(provider(vendor), Buffer.alloc(3200));

  const { query, authorization } = vendor.request();
  expect(authorization).toBe("Bearer test-key");
  expect(query.get("model")).toBe("grok-voice-transcribe-2.0");
  expect(query.get("encoding")).toBe("pcm");
  expect(query.get("sample_rate")).toBe("16000");
  expect(query.get("interim_results")).toBe("true");
});

test("text formatting is on by default, which needs a language", async () => {
  const vendor = await withVendor();

  await run(provider(vendor), Buffer.alloc(3200));

  const { query } = vendor.request();
  expect(query.get("format")).toBe("true");
  expect(query.get("language")).toBe("en");
});

test("formatting can be switched off, and the language left to auto-detection", async () => {
  const noFormat = await withVendor();
  await run(
    createXaiProvider({ apiKey: "k", baseUrl: noFormat.baseUrl, format: false }),
    Buffer.alloc(3200),
  );
  expect(noFormat.request().query.get("format")).toBeNull();
  expect(noFormat.request().query.get("language")).toBe("en");

  // No language, so no formatting either: the vendor would refuse `format` alone.
  const auto = await withVendor();
  await run(
    createXaiProvider({ apiKey: "k", baseUrl: auto.baseUrl, language: null }),
    Buffer.alloc(3200),
  );
  expect(auto.request().query.get("language")).toBeNull();
  expect(auto.request().query.get("format")).toBeNull();
});

test("audio waits for transcript.created, and audio.done waits behind it", async () => {
  const vendor = await withVendor({ createdDelayMs: 80 });
  // 7000 bytes: two whole chunks and a tail, all ready before the server is.
  const outcome = await run(provider(vendor), Buffer.alloc(7000));

  expect(outcome.error).toBeUndefined();
  expect(vendor.audioBeforeCreated()).toBe(false);
  expect(vendor.audioBytes()).toBe(7000);
  expect(vendor.clientMessages()).toEqual(["audio.done"]);
});

// --- Text ---

test("the final text is the utterance finals; transcript.done.text is empty and unused", async () => {
  const vendor = await withVendor({
    partials: [
      { text: "โปรเจกต์นี้เขียนด้วยภาษา" },
      { text: "โปรเจกต์นี้เขียนด้วยภาษา TypeScript", is_final: true },
      { text: "ใช้เฟรมเวิร์ก" },
      {
        text: "โปรเจกต์นี้เขียนด้วยภาษา TypeScript ใช้เฟรมเวิร์ก",
        is_final: true,
        speech_final: true,
      },
    ],
  });

  const outcome = await run(provider(vendor), Buffer.alloc(3200));

  expect(outcome.error).toBeUndefined();
  expect(outcome.text).toBe("โปรเจกต์นี้เขียนด้วยภาษา TypeScript ใช้เฟรมเวิร์ก");
});

test("partials show the locked chunks plus the chunk being heard", async () => {
  const vendor = await withVendor({
    partials: [
      { text: "Hello" },
      { text: "Hello there", is_final: true },
      { text: "my" },
      { text: "Hello there my friend", is_final: true, speech_final: true },
    ],
  });

  const outcome = await run(provider(vendor), Buffer.alloc(3200));

  // The utterance final replaces the chunks it was built from, so the last
  // partial is the whole utterance, not the chunks added to it a second time.
  expect(outcome.partials).toEqual([
    "Hello",
    "Hello there",
    "Hello there my",
    "Hello there my friend",
  ]);
  expect(outcome.text).toBe("Hello there my friend");
});

test("several utterances are joined, with a space between Latin runs and none between Thai", async () => {
  const vendor = await withVendor({
    partials: [
      { text: "First sentence.", is_final: true, speech_final: true },
      { text: "Second sentence.", is_final: true, speech_final: true },
      { text: "ประโยคแรก", is_final: true, speech_final: true },
      { text: "ประโยคสอง", is_final: true, speech_final: true },
    ],
  });

  const outcome = await run(provider(vendor), Buffer.alloc(3200));

  expect(outcome.text).toBe("First sentence. Second sentence.ประโยคแรกประโยคสอง");
});

test("with no utterance final, what was heard so far is still the answer", async () => {
  const vendor = await withVendor({
    partials: [{ text: "โปรเจกต์นี้", is_final: true }, { text: "TypeScript" }],
  });

  const outcome = await run(provider(vendor), Buffer.alloc(3200));

  expect(outcome.text).toBe("โปรเจกต์นี้ TypeScript");
});

test("a session with no speech reports no final text", async () => {
  const vendor = await withVendor();

  const outcome = await run(provider(vendor), Buffer.alloc(3200));

  expect(outcome.error).toBeUndefined();
  expect(outcome.text).toBe("");
});

// --- Usage ---

test("usage is the vendor's audio duration at $0.20 per hour", async () => {
  const vendor = await withVendor({ duration: 9.218 });

  const outcome = await run(provider(vendor), Buffer.alloc(3200));

  expect(outcome.usage).toEqual([
    { sku: "xai:grok-voice-transcribe-2.0:seconds", unitPrice: 0.2 / 3600, quantity: 9.218 },
  ]);
});

// --- Failure ---

test("an error event ends the session with an error", async () => {
  const vendor = await withVendor({ error: { message: "bad audio" } });

  const outcome = await run(provider(vendor), Buffer.alloc(3200));

  expect(outcome.error?.message).toContain("bad audio");
});

test("a connection dropped before transcript.done is an error, not a hang", async () => {
  const vendor = await withVendor({ dropOnDone: true });

  const outcome = await run(provider(vendor), Buffer.alloc(3200));

  expect(outcome.error?.message).toMatch(/closed before/);
});
