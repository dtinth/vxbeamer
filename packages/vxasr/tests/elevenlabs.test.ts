import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { expect, test } from "vite-plus/test";
import { createElevenLabsProvider } from "../src/index.ts";
import { run, trackVendors } from "./streamingSessionHarness.ts";

/**
 * A local stand-in for ElevenLabs' realtime speech-to-text socket, speaking the
 * protocol as observed live: `session_started` first, JSON `input_audio_chunk`
 * frames, a commit that is an empty chunk with `commit: true`, partials that
 * replace one another, and a `committed_transcript`. It enforces the real
 * rule that a commit with under 0.3 s of uncommitted audio is refused with
 * `commit_throttled` and the socket closed.
 */
interface FakeVendor {
  readonly baseUrl: string;
  readonly request: () => { query: URLSearchParams; apiKey: string | undefined };
  /** Bytes of audio received, and whether any arrived before `session_started` was sent. */
  readonly audioBytes: () => number;
  readonly audioBeforeStarted: () => boolean;
  readonly commits: () => number;
  /** Every `commit` flag, in frame order. */
  readonly frames: () => readonly { bytes: number; commit: boolean; sampleRate: number }[];
  close(): Promise<void>;
}

interface VendorOptions {
  /** Sent, in order, when the commit arrives, before `committed_transcript`. */
  partials?: string[];
  /** `committed_transcript` events sent after the first audio frame (the vendor's own ~36 s commit). */
  autoCommitted?: string[];
  /** The text of the committed transcript that answers our commit. */
  final?: string;
  /** Send this error frame instead of a transcript when the commit arrives. */
  error?: { message_type: string; error: string };
  /** Hang up when the commit arrives, without a word. */
  dropOnCommit?: boolean;
  startedDelayMs?: number;
}

async function startFakeVendor(options: VendorOptions = {}): Promise<FakeVendor> {
  const server: Server = createServer();
  const wss = new WebSocketServer({ server });

  let query = new URLSearchParams();
  let apiKey: string | undefined;
  let audioBytes = 0;
  let started = false;
  let audioBeforeStarted = false;
  let commits = 0;
  let sentAuto = false;
  const frames: { bytes: number; commit: boolean; sampleRate: number }[] = [];

  wss.on("connection", (ws: WebSocket, request) => {
    query = new URL(request.url ?? "", "ws://localhost").searchParams;
    const header = request.headers["xi-api-key"];
    apiKey = Array.isArray(header) ? header[0] : header;

    setTimeout(() => {
      started = true;
      ws.send(JSON.stringify({ message_type: "session_started", session_id: "s1" }));
    }, options.startedDelayMs ?? 20);

    ws.on("message", (raw: Buffer) => {
      const frame = JSON.parse(raw.toString());
      if (frame.message_type !== "input_audio_chunk") return;
      if (!started) audioBeforeStarted = true;
      const audio = Buffer.from(frame.audio_base_64, "base64");
      audioBytes += audio.length;
      frames.push({ bytes: audio.length, commit: frame.commit, sampleRate: frame.sample_rate });

      if (!sentAuto && options.autoCommitted && audio.length > 0) {
        sentAuto = true;
        for (const text of options.autoCommitted) {
          ws.send(JSON.stringify({ message_type: "committed_transcript", text }));
        }
      }
      if (!frame.commit) return;
      commits += 1;

      if (options.dropOnCommit) {
        ws.terminate();
        return;
      }
      if (audioBytes < 0.3 * 32000) {
        ws.send(
          JSON.stringify({
            message_type: "commit_throttled",
            error: `Session closed: only ${(audioBytes / 32000).toFixed(2)}s of uncommitted audio. You need at least 0.3s of uncommitted audio before committing.`,
          }),
        );
        ws.close(1000, "commit_throttled");
        return;
      }
      if (options.error) {
        ws.send(JSON.stringify(options.error));
        ws.close(1000, options.error.message_type);
        return;
      }
      for (const text of options.partials ?? []) {
        ws.send(JSON.stringify({ message_type: "partial_transcript", text }));
      }
      ws.send(JSON.stringify({ message_type: "committed_transcript", text: options.final ?? "" }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `ws://127.0.0.1:${port}/v1/speech-to-text/realtime`,
    request: () => ({ query, apiKey }),
    audioBytes: () => audioBytes,
    audioBeforeStarted: () => audioBeforeStarted,
    commits: () => commits,
    frames: () => frames,
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

function provider(vendor: FakeVendor, extra: { noVerbatim?: boolean; settleMs?: number } = {}) {
  return createElevenLabsProvider({ apiKey: "test-key", baseUrl: vendor.baseUrl, ...extra });
}

/** 1 s of audio, comfortably over the vendor's 0.3 s commit minimum. */
const ONE_SECOND = Buffer.alloc(32000);

/** 31 s: long enough that the vendor's own ~36 s commit may have happened. */
const LONG = Buffer.alloc(31 * 32000);

// --- Connection ---

test("the connection is configured in the query string, with the xi-api-key header", async () => {
  const vendor = await withVendor({ final: "x" });

  await run(provider(vendor), ONE_SECOND);

  const { query, apiKey } = vendor.request();
  expect(apiKey).toBe("test-key");
  expect(query.get("model_id")).toBe("scribe_v2_realtime");
  expect(query.get("audio_format")).toBe("pcm_16000");
  expect(query.get("commit_strategy")).toBe("manual");
  expect(query.get("no_verbatim")).toBeNull();
});

test("no_verbatim is sent only when asked for", async () => {
  const vendor = await withVendor({ final: "x" });

  await run(provider(vendor, { noVerbatim: true }), ONE_SECOND);

  expect(vendor.request().query.get("no_verbatim")).toBe("true");
});

// --- Sending ---

test("audio waits for session_started, then the turn ends with an empty chunk that commits", async () => {
  const vendor = await withVendor({ final: "hello", startedDelayMs: 80 });

  const outcome = await run(provider(vendor), Buffer.alloc(70000));

  expect(outcome.error).toBeUndefined();
  expect(vendor.audioBeforeStarted()).toBe(false);
  expect(vendor.audioBytes()).toBe(70000);
  const frames = vendor.frames();
  // Whole 100 ms chunks, then the tail, then the commit: an empty chunk.
  expect(frames.slice(0, -2).every((f) => f.bytes === 3200 && !f.commit)).toBe(true);
  expect(frames.at(-1)).toEqual({ bytes: 0, commit: true, sampleRate: 16000 });
  expect(vendor.commits()).toBe(1);
});

test("a recording under the vendor's 0.3 s minimum is padded with silence, not refused", async () => {
  const vendor = await withVendor({ final: "ok" });

  // 0.1 s: the vendor would answer commit_throttled and close the socket.
  const outcome = await run(provider(vendor), Buffer.alloc(3200));

  expect(outcome.error).toBeUndefined();
  expect(outcome.text).toBe("ok");
  expect(vendor.audioBytes()).toBeGreaterThanOrEqual(0.3 * 32000);
});

// --- Text ---

test("each partial replaces the one before it; the committed transcript is the final", async () => {
  const vendor = await withVendor({
    partials: ["Project นี้", "Project นี้เขียนด้วยภาษา", "Project นี้เขียนด้วยภาษา TypeScript"],
    final: "Project นี้เขียนด้วยภาษา TypeScript",
  });

  const outcome = await run(provider(vendor), ONE_SECOND);

  expect(outcome.partials).toEqual([
    "Project นี้",
    "Project นี้เขียนด้วยภาษา",
    "Project นี้เขียนด้วยภาษา TypeScript",
  ]);
  expect(outcome.text).toBe("Project นี้เขียนด้วยภาษา TypeScript");
});

test("a long recording waits out a commit the vendor made by itself, then joins the segments", async () => {
  // The fake sends its own commit after our commit was already on the wire, as a
  // fast dump does: the first committed segment is not the answer to ours.
  const vendor = await withVendor({
    autoCommitted: ["First segment."],
    partials: ["Second"],
    final: "Second segment.",
  });

  const outcome = await run(provider(vendor, { settleMs: 60 }), LONG);

  expect(outcome.error).toBeUndefined();
  expect(outcome.text).toBe("First segment. Second segment.");
  // The later partial is shown after the segment already committed, not alone.
  expect(outcome.partials.at(-1)).toBe("First segment. Second");
});

test("segments in Thai are joined without a space, and Latin runs with one", async () => {
  const vendor = await withVendor({ autoCommitted: ["ประโยคแรก"], final: "ประโยคสอง" });

  const outcome = await run(provider(vendor, { settleMs: 60 }), LONG);

  expect(outcome.text).toBe("ประโยคแรกประโยคสอง");
});

test("a recording that cannot have been auto-committed ends at the first committed segment, without waiting", async () => {
  const vendor = await withVendor({ final: "short" });
  const started = Date.now();

  // The default settle time is a full second; a short recording must not pay it.
  const outcome = await run(provider(vendor), ONE_SECOND);

  expect(outcome.text).toBe("short");
  expect(Date.now() - started).toBeLessThan(500);
});

test("a session with no speech reports no final text", async () => {
  const vendor = await withVendor({ final: "" });

  const outcome = await run(provider(vendor), ONE_SECOND);

  expect(outcome.error).toBeUndefined();
  expect(outcome.text).toBe("");
});

// --- Usage ---

test("usage is the real audio at $0.22 per hour, without the silence padding", async () => {
  const vendor = await withVendor({ final: "ok" });

  // 1.5 s of real audio.
  const outcome = await run(provider(vendor), Buffer.alloc(48000));

  expect(outcome.usage).toEqual([
    { sku: "elevenlabs:scribe_v2_realtime:seconds", unitPrice: 0.22 / 3600, quantity: 1.5 },
  ]);
});

test("a short recording is billed for what was said, not the padding", async () => {
  const vendor = await withVendor({ final: "ok" });

  const outcome = await run(provider(vendor), Buffer.alloc(3200));

  expect(outcome.usage[0]?.quantity).toBeCloseTo(0.1, 5);
});

// --- Failure ---

test("an error frame ends the session with its kind and text", async () => {
  const vendor = await withVendor({
    error: { message_type: "quota_exceeded", error: "You have exceeded your usage quota" },
  });

  const outcome = await run(provider(vendor), ONE_SECOND);

  expect(outcome.error?.message).toBe(
    "ElevenLabs quota_exceeded: You have exceeded your usage quota",
  );
});

test("a connection dropped before the transcript is an error, not a hang", async () => {
  const vendor = await withVendor({ dropOnCommit: true });

  const outcome = await run(provider(vendor), ONE_SECOND);

  expect(outcome.error?.message).toMatch(/closed before/);
});
