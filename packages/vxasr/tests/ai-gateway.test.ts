import type { TranscriptionStreamPart } from "ai";
import { expect, test } from "vite-plus/test";
import {
  AI_GATEWAY_DEFAULT_MODEL,
  createAIGatewayProvider,
  createDefaultConfigurationCatalogue,
  createDefaultProviderRegistry,
} from "../src/index.ts";
import { run } from "./streamingSessionHarness.ts";

/**
 * The gateway replaced by a script: it reads the whole audio stream (as the
 * SDK does), then yields the parts the test gives, in the shapes observed
 * live (dtinth/vxbeamer#86). No network.
 */
function scripted(
  parts: TranscriptionStreamPart[] | ((audio: Buffer) => TranscriptionStreamPart[]),
) {
  const calls: { apiKey: string; model: string; audio: Buffer; abortSignal: AbortSignal }[] = [];
  const streamTranscribe = (options: {
    apiKey: string;
    model: string;
    audio: ReadableStream<Uint8Array>;
    abortSignal: AbortSignal;
  }) => {
    const call = { ...options, audio: Buffer.alloc(0) };
    calls.push(call);
    return {
      fullStream: (async function* () {
        for await (const chunk of options.audio) call.audio = Buffer.concat([call.audio, chunk]);
        yield* typeof parts === "function" ? parts(call.audio) : parts;
      })(),
    };
  };
  return { calls, streamTranscribe };
}

const provider = (gateway: ReturnType<typeof scripted>) =>
  createAIGatewayProvider({ apiKey: "test-key", streamTranscribe: gateway.streamTranscribe });

test("passes the key, the model and every audio byte to the gateway", async () => {
  const gateway = scripted([{ type: "transcript-final", text: "" }]);
  const clip = Buffer.alloc(6500, 7);

  await run(provider(gateway), clip);

  expect(gateway.calls).toHaveLength(1);
  expect(gateway.calls[0]).toMatchObject({ apiKey: "test-key", model: AI_GATEWAY_DEFAULT_MODEL });
  expect(gateway.calls[0]!.audio.equals(clip)).toBe(true);
});

test("a partial is the committed deltas plus the provisional text after them", async () => {
  const gateway = scripted([
    { type: "transcript-partial", text: "โปรเจกต์นี้" },
    { type: "transcript-delta", delta: "โปรเจ" },
    { type: "transcript-partial", text: "กต์นี้เขียนด้วย" },
    { type: "transcript-delta", delta: "กต์นี้เขียนด้วย" },
    { type: "transcript-final", text: "โปรเจกต์นี้เขียนด้วย" },
  ]);

  const outcome = await run(provider(gateway), Buffer.alloc(3200));

  expect(outcome.partials).toEqual(["โปรเจกต์นี้", "โปรเจ", "โปรเจกต์นี้เขียนด้วย", "โปรเจกต์นี้เขียนด้วย"]);
  expect(outcome.text).toBe("โปรเจกต์นี้เขียนด้วย");
});

test("the final transcript wins over the joined deltas", async () => {
  const gateway = scripted([
    { type: "transcript-delta", delta: "draft" },
    { type: "transcript-final", text: "the final text" },
  ]);

  const outcome = await run(provider(gateway), Buffer.alloc(3200));

  expect(outcome.text).toBe("the final text");
});

test("silence: an empty final ends the session cleanly, with no error", async () => {
  const gateway = scripted([{ type: "transcript-final", text: "" }]);

  const outcome = await run(provider(gateway), Buffer.alloc(3200));

  expect(outcome.error).toBeUndefined();
  expect(outcome.text).toBe("");
});

test("usage is the audio sent, at $0.54 an hour", async () => {
  const gateway = scripted([{ type: "transcript-final", text: "x" }]);

  const outcome = await run(provider(gateway), Buffer.alloc(32000 * 2)); // 2 s

  expect(outcome.usage).toEqual([
    {
      sku: `ai-gateway:${AI_GATEWAY_DEFAULT_MODEL}:seconds`,
      unitPrice: 0.54 / 3600,
      quantity: 2,
    },
  ]);
});

test("an error part fails the session", async () => {
  const gateway = scripted([{ type: "error", error: new Error("model not enabled") }]);

  const outcome = await run(provider(gateway), Buffer.alloc(3200));

  expect(outcome.error?.message).toBe("model not enabled");
});

test("a thrown error fails the session", async () => {
  const gateway = scripted(() => {
    throw new Error("connection refused");
  });

  const outcome = await run(provider(gateway), Buffer.alloc(3200));

  expect(outcome.error?.message).toBe("connection refused");
});

test("close() aborts the gateway call and reports nothing", async () => {
  const gateway = scripted([{ type: "transcript-final", text: "too late" }]);
  const events: string[] = [];
  const session = provider(gateway).createSession({
    onFinal: () => events.push("final"),
    onEnd: () => events.push("end"),
    onError: () => events.push("error"),
  });
  session.sendAudio(Buffer.alloc(3200));
  session.close();
  session.finish(); // after close: ignored, so the stream never ends

  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(gateway.calls[0]?.abortSignal.aborted).toBe(true);
  expect(events).toEqual([]);
});

test("the ai-gateway provider needs AI_GATEWAY_API_KEY, and its configuration is offered", () => {
  expect(createDefaultProviderRegistry().get("ai-gateway")?.missingConfig({})).toEqual([
    "AI_GATEWAY_API_KEY",
  ]);
  const ids = createDefaultConfigurationCatalogue()
    .list()
    .map((c) => c.id);
  expect(ids).toContain(`ai-gateway/${AI_GATEWAY_DEFAULT_MODEL}`);
});
