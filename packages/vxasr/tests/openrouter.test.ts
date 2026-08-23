import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { expect, test } from "vite-plus/test";
import { createOpenRouterProvider, OPENROUTER_DEFAULT_MODEL } from "../src/index.ts";
import { run, trackVendors } from "./streamingSessionHarness.ts";

/**
 * A local stand-in for OpenRouter's transcription endpoint. Unlike the
 * WebSocket vendors' fakes, this parses a real multipart POST — via a Web
 * `Request` built from the raw HTTP body, so the parsing is the same code
 * a real client and server would use, not a hand-rolled multipart reader.
 */
interface FakeVendor {
  readonly baseUrl: string;
  readonly requestedModel: () => string | undefined;
  readonly authorization: () => string | undefined;
  readonly receivedAudioBytes: () => number;
  close(): Promise<void>;
}

const TRANSCRIPT = "โปรเจกต์นี้เขียนด้วยภาษา TypeScript";

async function startFakeVendor(
  options: {
    text?: string;
    cost?: number;
    status?: number;
    errorBody?: string;
    delayMs?: number;
  } = {},
): Promise<FakeVendor> {
  const server: Server = createServer();
  let requestedModel: string | undefined;
  let authorization: string | undefined;
  let receivedAudioBytes = 0;

  server.on("request", (req, res) => {
    void (async () => {
      authorization = req.headers.authorization;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const request = new Request("http://fake-vendor/", {
        method: "POST",
        headers: { "content-type": req.headers["content-type"] ?? "" },
        body,
      });
      const form = await request.formData();
      const modelField = form.get("model");
      requestedModel = typeof modelField === "string" ? modelField : undefined;
      const file = form.get("file");
      if (file instanceof Blob) {
        receivedAudioBytes = (await file.arrayBuffer()).byteLength;
      }

      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));

      if (options.status && options.status !== 200) {
        res.writeHead(options.status, { "content-type": "text/plain" });
        res.end(options.errorBody ?? "error");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          text: options.text ?? TRANSCRIPT,
          usage: { cost: options.cost ?? 0.001, seconds: 9.2 },
        }),
      );
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/`,
    requestedModel: () => requestedModel,
    authorization: () => authorization,
    receivedAudioBytes: () => receivedAudioBytes,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const { withVendor: track } = trackVendors<FakeVendor>();

async function withVendor(options: Parameters<typeof startFakeVendor>[0] = {}) {
  return track(() => startFakeVendor(options));
}

function provider(vendor: FakeVendor, model = OPENROUTER_DEFAULT_MODEL) {
  return createOpenRouterProvider({ apiKey: "test-key", model, baseUrl: vendor.baseUrl });
}

test("sends the model and the whole clip as one file, and returns the transcript", async () => {
  const vendor = await withVendor();
  const audio = Buffer.alloc(6400, 7);

  const outcome = await run(provider(vendor), audio);

  expect(outcome.text).toBe(TRANSCRIPT);
  expect(outcome.error).toBeUndefined();
  expect(vendor.requestedModel()).toBe(OPENROUTER_DEFAULT_MODEL);
  expect(vendor.authorization()).toBe("Bearer test-key");
});

test("the uploaded file carries a WAV header, not headerless PCM", async () => {
  const vendor = await withVendor();
  const audio = Buffer.alloc(6400, 7);

  await run(provider(vendor), audio);

  expect(vendor.receivedAudioBytes()).toBe(44 + audio.length);
});

test("reports the vendor's own cost as usage — quantity 1 at the reported price", async () => {
  const vendor = await withVendor({ cost: 0.00042 });

  const outcome = await run(provider(vendor), Buffer.alloc(3200));

  expect(outcome.usage).toEqual([
    { sku: `openrouter:${OPENROUTER_DEFAULT_MODEL}:cost`, unitPrice: 0.00042, quantity: 1 },
  ]);
});

test("no partials — this is one request, not a stream", async () => {
  const vendor = await withVendor();

  const outcome = await run(provider(vendor), Buffer.alloc(3200));

  expect(outcome.partials).toEqual([]);
});

test("a non-200 response surfaces as an error naming the status and body", async () => {
  const vendor = await withVendor({ status: 402, errorBody: "insufficient credits" });

  const outcome = await run(provider(vendor), Buffer.alloc(3200));

  expect(outcome.error?.message).toContain("402");
  expect(outcome.error?.message).toContain("insufficient credits");
});

test("close() before finish() never sends a request or fires a callback", async () => {
  const vendor = await withVendor();
  let called = false;
  const session = provider(vendor).createSession({
    onFinal: () => (called = true),
    onEnd: () => (called = true),
    onError: () => (called = true),
  });

  session.sendAudio(Buffer.alloc(3200));
  session.close();
  await new Promise((r) => setTimeout(r, 20));

  expect(called).toBe(false);
  expect(vendor.requestedModel()).toBeUndefined();
});

test("close() while the request is in flight aborts it silently", async () => {
  const vendor = await withVendor({ delayMs: 200 });
  let called = false;
  const session = provider(vendor).createSession({
    onFinal: () => (called = true),
    onEnd: () => (called = true),
    onError: () => (called = true),
  });

  session.sendAudio(Buffer.alloc(3200));
  session.finish();
  await new Promise((r) => setTimeout(r, 20)); // let the request actually start
  session.close();
  await new Promise((r) => setTimeout(r, 300)); // past the vendor's delay

  expect(called).toBe(false);
});
