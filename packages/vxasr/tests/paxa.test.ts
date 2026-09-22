import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { expect, test } from "vite-plus/test";
import {
  createPaxaProvider,
  createDefaultConfigurationCatalogue,
  createDefaultProviderRegistry,
  PAXA_DEFAULT_MODEL,
} from "../src/index.ts";
import { run, trackVendors } from "./streamingSessionHarness.ts";

/**
 * A local stand-in for Paxa's endpoint. Unlike OpenRouter's multipart upload
 * this one takes JSON with the audio base64-encoded in the body, so the fake
 * parses the real JSON a real client would send — the encoding is the part
 * most worth getting wrong quietly.
 */
interface FakeVendor {
  readonly baseUrl: string;
  readonly body: () => Record<string, unknown> | undefined;
  readonly authorization: () => string | undefined;
  readonly audio: () => Buffer;
  close(): Promise<void>;
}

const TRANSCRIPT = "เห็นด้วยตามที่แนะนำครับผม";

async function startFakeVendor(
  options: {
    text?: string;
    seconds?: number | null;
    credits?: number;
    status?: number;
    errorBody?: string;
  } = {},
): Promise<FakeVendor> {
  const server: Server = createServer();
  let body: Record<string, unknown> | undefined;
  let authorization: string | undefined;
  let audio = Buffer.alloc(0);

  server.on("request", (req, res) => {
    void (async () => {
      authorization = req.headers.authorization;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      audio = Buffer.from(String(body.audio ?? ""), "base64");

      if (options.status && options.status !== 200) {
        res.writeHead(options.status, { "content-type": "text/plain" });
        res.end(options.errorBody ?? "error");
        return;
      }
      const usage: Record<string, number> = { credits: options.credits ?? 0.3 };
      if (options.seconds !== null) usage.seconds = options.seconds ?? 2.1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: options.text ?? TRANSCRIPT, usage }));
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/`,
    body: () => body,
    authorization: () => authorization,
    audio: () => audio,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const { withVendor: track } = trackVendors<FakeVendor>();

async function withVendor(options: Parameters<typeof startFakeVendor>[0] = {}) {
  return track(() => startFakeVendor(options));
}

function provider(vendor: FakeVendor, config: { convention?: "spoken" | "written" } = {}) {
  return createPaxaProvider({ apiKey: "test-key", baseUrl: vendor.baseUrl, ...config });
}

// --- The request carries WAV, base64, in JSON ---

test("the audio is sent as a base64 WAV in the JSON body", async () => {
  const vendor = await withVendor();
  // 3200 bytes = 100 ms at 16 kHz 16-bit mono.
  await run(provider(vendor), Buffer.alloc(3200, 7));

  const audio = vendor.audio();
  // A 44-byte canonical header, then the PCM exactly as captured.
  expect(audio.subarray(0, 4).toString()).toBe("RIFF");
  expect(audio.subarray(8, 12).toString()).toBe("WAVE");
  expect(audio.length).toBe(44 + 3200);
  expect(audio.subarray(44)).toEqual(Buffer.alloc(3200, 7));
});

test("the request names the model and authenticates with a bearer token", async () => {
  const vendor = await withVendor();

  await run(provider(vendor), Buffer.alloc(3200));

  expect(vendor.body()?.model).toBe(PAXA_DEFAULT_MODEL);
  expect(vendor.authorization()).toBe("Bearer test-key");
});

test("the convention is only sent when one was chosen", async () => {
  // The vendor has its own default, and the difference between the two is
  // invisible on audio without numbers — so sending nothing is deliberate,
  // not an oversight (dtinth/vxbeamer#86).
  const plain = await withVendor();
  await run(provider(plain), Buffer.alloc(3200));
  expect("convention" in (plain.body() ?? {})).toBe(false);

  const chosen = await withVendor();
  await run(provider(chosen, { convention: "written" }), Buffer.alloc(3200));
  expect(chosen.body()?.convention).toBe("written");
});

// --- Reading the result ---

test("the transcript comes back as the final, with no partials", async () => {
  const vendor = await withVendor({ text: "hello there" });

  const outcome = await run(provider(vendor), Buffer.alloc(6400));

  expect(outcome.text).toBe("hello there");
  // A batch endpoint has nothing to stream, so a caller must not be left
  // waiting for partials that never come.
  expect(outcome.partials).toEqual([]);
});

test("usage is billed by the seconds the vendor says it billed", async () => {
  const vendor = await withVendor({ seconds: 13.016 });

  const outcome = await run(provider(vendor), Buffer.alloc(3200));

  expect(outcome.usage).toHaveLength(1);
  const [record] = outcome.usage;
  expect(record?.sku).toBe(`paxa:${PAXA_DEFAULT_MODEL}:seconds`);
  expect(record?.quantity).toBe(13.016);
  // 8.33 credits a minute at ฿329 per 10,000 credits, converted at ฿35/USD.
  expect(record?.unitPrice).toBeCloseTo((8.33 / 60) * (329 / 10_000 / 35), 10);
});

test("a response with no seconds bills nothing rather than guessing", async () => {
  const vendor = await withVendor({ seconds: null });

  const outcome = await run(provider(vendor), Buffer.alloc(3200));

  expect(outcome.text).toBe(TRANSCRIPT);
  expect(outcome.usage).toEqual([]);
});

test("an error response fails the session with the body included", async () => {
  const vendor = await withVendor({ status: 429, errorBody: '{"title":"rate_limited"}' });

  const outcome = await run(provider(vendor), Buffer.alloc(3200));

  expect(outcome.error?.message).toContain("429");
  expect(outcome.error?.message).toContain("rate_limited");
});

// --- The registry and catalogue ---

test("the provider needs PAXA_API_KEY and defaults to the lite model", () => {
  const registry = createDefaultProviderRegistry();

  expect(registry.get("paxa")?.missingConfig({})).toEqual(["PAXA_API_KEY"]);
  expect(registry.get("paxa")?.defaultModel).toBe(PAXA_DEFAULT_MODEL);
});

test("the paxa configuration is offered raw, never enhanced", () => {
  const catalogue = createDefaultConfigurationCatalogue();

  const paxa = catalogue.list().filter((c) => c.providerId === "paxa");

  // Nothing to tidy: it already renders Thai without inter-word spaces and
  // keeps Latin technical terms in Latin, unprompted.
  expect(paxa.map((c) => c.id)).toEqual([`paxa/${PAXA_DEFAULT_MODEL}`]);
  expect(paxa[0]?.postProcessing).toEqual([]);
});
