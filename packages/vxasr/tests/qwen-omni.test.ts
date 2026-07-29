import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { expect, test } from "vite-plus/test";
import {
  QWEN_OMNI_PRICING,
  QWEN_OMNI_TRANSCRIPTION_INSTRUCTIONS,
  createQwenOmniProvider,
  createDefaultConfigurationCatalogue,
  createDefaultProviderRegistry,
} from "../src/index.ts";
import { run, trackVendors, type RunOutcome } from "./streamingSessionHarness.ts";

/**
 * A local stand-in for DashScope. It speaks just enough of the Omni realtime
 * protocol to let a session complete, and records what the adapter sent it.
 *
 * The subject here is the wire: whether the session is configured as a
 * transcriber rather than a chatbot, whether the turn is ended with the
 * commit + `response.create` this protocol wants rather than the ASR protocol's
 * `session.finish`, and whether tokens are billed at the right model's rates.
 * None of that is observable without a server on the other end. No network.
 */
interface FakeVendor {
  readonly baseUrl: string;
  /** `?model=` the adapter connected with. */
  readonly model: () => string | undefined;
  readonly authorization: () => string | undefined;
  /** The `session.update` payload's `session` object. */
  readonly session: () => Promise<Record<string, any>>;
  /** Every client event type, in order. */
  readonly events: () => readonly string[];
  /** Base64-decoded audio the adapter appended, concatenated. */
  readonly audio: () => Buffer;
  close(): Promise<void>;
}

const TRANSCRIPT = "โปรเจกต์นี้เขียนด้วยภาษา TypeScript";

async function startFakeVendor(
  options: { text?: string; usage?: object; error?: object } = {},
): Promise<FakeVendor> {
  const server: Server = createServer();
  const wss = new WebSocketServer({ server });

  let model: string | undefined;
  let authorization: string | undefined;
  const events: string[] = [];
  let audio = Buffer.alloc(0);
  let resolveSession: (payload: Record<string, any>) => void;
  const session = new Promise<Record<string, any>>((resolve) => {
    resolveSession = resolve;
  });

  wss.on("connection", (ws: WebSocket, request) => {
    model = new URL(request.url ?? "", "ws://localhost").searchParams.get("model") ?? undefined;
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
      } else if (data.type === "response.create") {
        if (options.error) {
          ws.send(JSON.stringify({ type: "error", ...options.error }));
          return;
        }
        // Deltas are incremental: the vendor sends fragments, not the running
        // text, so a fake that sends whole strings would not catch a bug here.
        const text = options.text ?? TRANSCRIPT;
        const half = Math.floor(text.length / 2);
        ws.send(JSON.stringify({ type: "response.text.delta", delta: text.slice(0, half) }));
        ws.send(JSON.stringify({ type: "response.text.delta", delta: text.slice(half) }));
        ws.send(JSON.stringify({ type: "response.text.done", text }));
        ws.send(
          JSON.stringify({
            type: "response.done",
            response: {
              usage: options.usage ?? {
                total_tokens: 146,
                input_tokens: 114,
                output_tokens: 32,
                input_tokens_details: { text_tokens: 44, audio_tokens: 70 },
                output_tokens_details: { text_tokens: 32 },
              },
            },
          }),
        );
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `ws://127.0.0.1:${port}`,
    model: () => model,
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

const FLASH = "qwen3.5-omni-flash-realtime-2026-03-15";

function provider(vendor: FakeVendor, model = FLASH) {
  return createQwenOmniProvider({ apiKey: "test-key", model, baseUrl: vendor.baseUrl });
}

// --- The session is configured as a transcriber ---

test("the session instructs the model to transcribe rather than converse", async () => {
  const vendor = await withVendor();

  await run(provider(vendor), Buffer.alloc(3200));

  const session = await vendor.session();
  // Without this the model does not produce a worse transcript, it produces a
  // conversation *about* the audio. It is input, not decoration.
  expect(session.instructions).toBe(QWEN_OMNI_TRANSCRIPTION_INSTRUCTIONS);
  expect(session.modalities).toEqual(["text"]);
  // `pcm`, not the `pcm16` the OpenAI realtime protocol names.
  expect(session.input_audio_format).toBe("pcm");
  expect(session.sample_rate).toBe(16000);
  // The recording decides when the turn ends, not a silence detector.
  expect(session.turn_detection).toBe(null);
});

test("the separate transcription sub-service is silenced by naming no model", async () => {
  const vendor = await withVendor();

  await run(provider(vendor), Buffer.alloc(3200));

  // Naming a model here would start a *second* ASR model on our audio whose
  // output is not this model's and which we never read. An empty object turns
  // it off; omitting the field lets the vendor pick one.
  expect((await vendor.session()).input_audio_transcription).toEqual({});
});

test("the connection names the model and carries bearer auth", async () => {
  const vendor = await withVendor();

  await run(provider(vendor, "qwen3.5-omni-plus-realtime-2026-03-15"), Buffer.alloc(3200));

  expect(vendor.model()).toBe("qwen3.5-omni-plus-realtime-2026-03-15");
  expect(vendor.authorization()).toBe("Bearer test-key");
});

// --- The turn is ended this protocol's way ---

test("a turn ends with a commit and a response request, never session.finish", async () => {
  const vendor = await withVendor();

  const outcome = await run(provider(vendor), Buffer.alloc(6400));

  expect(outcome.text).toBe(TRANSCRIPT);
  expect(vendor.events()).toEqual([
    "session.update",
    "input_audio_buffer.append",
    "input_audio_buffer.append",
    "input_audio_buffer.commit",
    // Committing only closes the input. Without this the model is never asked
    // for anything and the session hangs — which is what `session.finish` does
    // to these models, and why `qwen` times out against them.
    "response.create",
  ]);
  expect(vendor.events()).not.toContain("session.finish");
});

test("audio arrives whole, including a tail shorter than a chunk", async () => {
  const vendor = await withVendor();
  // 1.5 chunks: the remainder must still be sent, or the model hears a clipped
  // recording.
  const audio = Buffer.alloc(4800, 7);

  await run(provider(vendor), audio);

  expect(vendor.audio()).toEqual(audio);
});

test("a clip that finishes before the socket opens is still transcribed", async () => {
  const vendor = await withVendor();
  // `finish()` lands before the `open` handler has sent `session.update`, so
  // the session must complete itself rather than drop the turn on the floor.
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
  const vendor = await withVendor({ text: "abcd" });

  const outcome = await run(provider(vendor), Buffer.alloc(3200));

  // Cumulative, not each fragment alone: this protocol's deltas are increments.
  expect(outcome.partials).toEqual(["ab", "abcd"]);
  expect(outcome.text).toBe("abcd");
});

test("an error event fails the session", async () => {
  const vendor = await withVendor({ error: { error: { message: "nope" } } });

  const outcome = await run(provider(vendor), Buffer.alloc(3200));

  expect(outcome.error?.message).toContain("nope");
});

// --- Billing is in tokens, at this model's rates ---

test("usage is billed as measured tokens, audio and text priced apart", async () => {
  const vendor = await withVendor();

  const outcome = await run(provider(vendor), Buffer.alloc(3200));

  // The vendor prices audio input and text input differently, so one input SKU
  // would misreport the cost.
  expect(outcome.usage).toEqual([
    { sku: `dashscope:${FLASH}:input-audio-tokens`, unitPrice: 4.5e-6, quantity: 70 },
    { sku: `dashscope:${FLASH}:input-text-tokens`, unitPrice: 0.55e-6, quantity: 44 },
    { sku: `dashscope:${FLASH}:output-text-tokens`, unitPrice: 17.7e-6, quantity: 32 },
  ]);
});

test("each model is billed at its own rates", async () => {
  const vendor = await withVendor();

  const outcome = await run(
    provider(vendor, "qwen3.5-omni-plus-realtime-2026-03-15"),
    Buffer.alloc(3200),
  );

  // Plus is over 3x flash on the same tokens — a per-provider constant would be
  // wrong for two of the three models.
  expect(outcome.usage.map((record) => record.unitPrice)).toEqual([16.5e-6, 2.1e-6, 62.0e-6]);
  expect(outcome.usage.every((record) => record.sku.includes("plus-realtime"))).toBe(true);
});

test("a model with no published rates is refused rather than billed at zero", () => {
  // The registry allowlists models before the adapter is reached, so this is a
  // programming error — and silently charging $0 would hide it.
  expect(() => createQwenOmniProvider({ apiKey: "k", model: "qwen-imaginary" })).toThrow(
    /No pricing/,
  );
});

test("every model the provider serves has rates", () => {
  for (const model of createDefaultProviderRegistry().get("qwen-omni")!.models) {
    expect(QWEN_OMNI_PRICING[model]).toBeDefined();
  }
});

// --- The catalogue ---

test("the omni configurations are offered raw, never enhanced", () => {
  const catalogue = createDefaultConfigurationCatalogue();

  const omni = catalogue.list().filter((c) => c.providerId === "qwen-omni");

  // These models already render Thai in Thai and product names in Latin — the
  // shape the Groq enhancement exists to reach. A `+groq` variant would buy a
  // second LLM call with a vote slot and add nothing.
  expect(omni.map((c) => c.id)).toEqual([
    "qwen-omni/qwen3.5-omni-flash-realtime-2026-03-15",
    "qwen-omni/qwen3.5-omni-plus-realtime-2026-03-15",
    "qwen-omni/qwen3-omni-flash-realtime-2025-12-01",
  ]);
  for (const configuration of omni) {
    expect(configuration.postProcessing).toEqual([]);
  }
});

test("qwen-omni is a separate provider from qwen, sharing only the key", () => {
  const registry = createDefaultProviderRegistry();

  // Same vendor and same credential, different protocol and different billing —
  // so `ASR_PROVIDER=qwen` can never reach an omni model by naming one in
  // `ASR_MODEL`, and one provider id keeps meaning one wire protocol.
  expect(registry.get("qwen-omni")?.missingConfig({})).toEqual(["DASHSCOPE_API_KEY"]);
  expect(registry.get("qwen")?.models).not.toContain("qwen3.5-omni-flash-realtime-2026-03-15");
  expect(registry.get("qwen-omni")?.defaultModel).toBe(FLASH);
});
