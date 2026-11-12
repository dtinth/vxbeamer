import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { expect, test } from "vite-plus/test";
import {
  QWEN_AUDIO_PRICING,
  createDefaultConfigurationCatalogue,
  createQwenAudioProvider,
} from "../src/index.ts";
import { run, trackVendors } from "./streamingSessionHarness.ts";

/**
 * A local stand-in for DashScope's duplex `run-task` endpoint. The subject is
 * the wire: audio held until `task-started`, `finish-task` ending the turn,
 * sentences stitched together, tokens billed at the model's rates. No network.
 */
interface FakeVendor {
  readonly url: string;
  readonly authorization: () => string | undefined;
  /** The `payload` of the `run-task` frame. */
  readonly task: () => Promise<Record<string, any>>;
  /** Client actions and binary frames, in order: `run-task`, `audio`, `finish-task`. */
  readonly events: () => readonly string[];
  readonly audio: () => Buffer;
  close(): Promise<void>;
}

interface Sentence {
  id: number;
  text: string;
  end: boolean;
}

async function startFakeVendor(
  options: {
    /** What to emit once `finish-task` arrives. */
    sentences?: readonly Sentence[];
    /** Delay `task-started`, to prove audio is held until it arrives. */
    startDelayMs?: number;
    fail?: { code: string; message: string };
  } = {},
): Promise<FakeVendor> {
  const server: Server = createServer();
  const wss = new WebSocketServer({ server });

  let authorization: string | undefined;
  const events: string[] = [];
  let audio = Buffer.alloc(0);
  let resolveTask: (payload: Record<string, any>) => void;
  const task = new Promise<Record<string, any>>((resolve) => {
    resolveTask = resolve;
  });
  let started = false;

  wss.on("connection", (ws: WebSocket, request) => {
    authorization = request.headers.authorization;

    ws.on("message", (raw: Buffer, isBinary: boolean) => {
      if (isBinary) {
        // Audio before `task-started` is a protocol violation: the vendor says
        // it may only be sent after.
        events.push(started ? "audio" : "audio-before-started");
        audio = Buffer.concat([audio, raw]);
        return;
      }
      const frame = JSON.parse(raw.toString());
      const action = frame.header.action;
      events.push(action);

      if (action === "run-task") {
        resolveTask(frame.payload);
        setTimeout(() => {
          started = true;
          if (options.fail) {
            ws.send(
              JSON.stringify({
                header: {
                  event: "task-failed",
                  task_id: frame.header.task_id,
                  error_code: options.fail.code,
                  error_message: options.fail.message,
                },
                payload: {},
              }),
            );
            return;
          }
          ws.send(
            JSON.stringify({
              header: { event: "task-started", task_id: frame.header.task_id },
              payload: {},
            }),
          );
        }, options.startDelayMs ?? 0);
      } else if (action === "finish-task") {
        const sentences = options.sentences ?? [
          { id: 1, text: "โปรเจกต์นี้", end: false },
          { id: 1, text: "โปรเจกต์นี้เขียนด้วยภาษา TypeScript", end: true },
        ];
        for (const s of sentences) {
          ws.send(
            JSON.stringify({
              header: { event: "result-generated", task_id: frame.header.task_id },
              payload: {
                output: {
                  sentence: { sentence_id: s.id, sentence_end: s.end, text: s.text },
                },
                usage: { duration: 9, input_tokens: 116, output_tokens: 54, total_tokens: 170 },
              },
            }),
          );
        }
        ws.send(
          JSON.stringify({
            header: { event: "task-finished", task_id: frame.header.task_id },
            payload: {
              output: {},
              usage: { duration: 9, input_tokens: 116, output_tokens: 54, total_tokens: 170 },
            },
          }),
        );
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `ws://127.0.0.1:${port}/api-ws/v1/inference`,
    authorization: () => authorization,
    task: () => task,
    events: () => events,
    audio: () => audio,
    async close() {
      for (const client of wss.clients) client.terminate();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const { withVendor: track } = trackVendors<FakeVendor>();

async function withVendor(options: Parameters<typeof startFakeVendor>[0] = {}) {
  return track(() => startFakeVendor(options));
}

const MESSAGE = "qwen-audio-3.1-asr-flash-message";
const STREAMING = "qwen-audio-3.1-asr-flash-streaming";

function provider(vendor: FakeVendor, model = MESSAGE) {
  return createQwenAudioProvider({ apiKey: "test-key", model, baseUrl: vendor.url });
}

test("run-task names the model and sends 16 kHz PCM, with the key as a bearer token", async () => {
  const vendor = await withVendor();

  await run(provider(vendor, STREAMING), Buffer.alloc(3200));

  const task = await vendor.task();
  expect(task.model).toBe(STREAMING);
  expect(task.task_group).toBe("audio");
  expect(task.task).toBe("asr");
  expect(task.function).toBe("recognition");
  expect(task.parameters.format).toBe("pcm");
  expect(task.parameters.sample_rate).toBe(16000);
  // The message model sends only finals unless asked; partials are what tell
  // the user they are being heard.
  expect(task.parameters.intermediate_result_enabled).toBe(true);
  expect(vendor.authorization()).toBe("bearer test-key");
});

test("audio is held until task-started and finish-task goes last", async () => {
  const vendor = await withVendor({ startDelayMs: 60 });

  // The whole clip is ready, and finished, before the vendor says it is ready.
  const outcome = await run(provider(vendor), Buffer.alloc(3200 * 3 + 100));

  expect(outcome.error).toBeUndefined();
  expect(vendor.events()).not.toContain("audio-before-started");
  expect(vendor.events()[0]).toBe("run-task");
  expect(vendor.events().at(-1)).toBe("finish-task");
  // Nothing is dropped on the way: three full chunks and the 100-byte tail.
  expect(vendor.audio().length).toBe(3200 * 3 + 100);
});

test("partials grow, and the final replaces them", async () => {
  const vendor = await withVendor();

  const outcome = await run(provider(vendor), Buffer.alloc(3200));

  expect(outcome.partials).toEqual(["โปรเจกต์นี้"]);
  expect(outcome.text).toBe("โปรเจกต์นี้เขียนด้วยภาษา TypeScript");
});

test("finished sentences are joined: no space in Thai, a space between Latin runs", async () => {
  const vendor = await withVendor({
    sentences: [
      { id: 1, text: "สวัสดีครับ", end: true },
      { id: 2, text: "ทดสอบ", end: true },
      { id: 3, text: "Hello.", end: true },
      { id: 4, text: "World", end: true },
    ],
  });

  const outcome = await run(provider(vendor), Buffer.alloc(3200));

  expect(outcome.text).toBe("สวัสดีครับทดสอบHello. World");
});

test("a partial shows the sentences already finished plus the one in progress", async () => {
  const vendor = await withVendor({
    sentences: [
      { id: 1, text: "Hello.", end: true },
      { id: 2, text: "Wor", end: false },
      { id: 2, text: "World", end: true },
    ],
  });

  const outcome = await run(provider(vendor), Buffer.alloc(3200));

  expect(outcome.partials).toEqual(["Hello. Wor"]);
  expect(outcome.text).toBe("Hello. World");
});

test("usage is the vendor's measured tokens at the model's rates", async () => {
  const vendor = await withVendor();

  const outcome = await run(provider(vendor), Buffer.alloc(3200));

  expect(outcome.usage).toEqual([
    { sku: `dashscope:${MESSAGE}:input-tokens`, unitPrice: 0.93e-6, quantity: 116 },
    { sku: `dashscope:${MESSAGE}:output-tokens`, unitPrice: 0.7e-6, quantity: 54 },
  ]);
});

test("a failed task surfaces the vendor's error", async () => {
  const vendor = await withVendor({ fail: { code: "InvalidParameter", message: "bad format" } });

  const outcome = await run(provider(vendor), Buffer.alloc(3200));

  expect(outcome.error?.message).toContain("InvalidParameter");
  expect(outcome.error?.message).toContain("bad format");
});

test("the endpoint is per workspace, so a missing workspace id fails fast", () => {
  expect(() => createQwenAudioProvider({ apiKey: "k" })).toThrow(/DASHSCOPE_WORKSPACE_ID/);
});

test("both models are priced and offered as configurations", () => {
  expect(Object.keys(QWEN_AUDIO_PRICING).sort()).toEqual([MESSAGE, STREAMING].sort());
  const ids = createDefaultConfigurationCatalogue()
    .list()
    .map((c) => c.id);
  expect(ids).toContain(`qwen-audio/${MESSAGE}`);
  expect(ids).toContain(`qwen-audio/${STREAMING}`);
});

test("both keys are required, and the missing one is named", () => {
  const catalogue = createDefaultConfigurationCatalogue();
  const resolution = catalogue.resolve({ DASHSCOPE_API_KEY: "k" }, `qwen-audio/${MESSAGE}`);
  expect(resolution.ok).toBe(false);
  if (!resolution.ok) expect(resolution.error.missing).toEqual(["DASHSCOPE_WORKSPACE_ID"]);
});
