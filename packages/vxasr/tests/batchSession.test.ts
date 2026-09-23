import { expect, test } from "vite-plus/test";
import type { UsageRecord } from "../src/asr.ts";
import { createBatchSession, type BatchTranscribe } from "../src/providers/batchSession.ts";

/**
 * The helper on its own, with no HTTP: `transcribe` is a plain function, so
 * each test controls exactly when (and whether) the vendor call settles. The
 * per-vendor request and response mapping is covered by `openrouter.test.ts`
 * and `paxa.test.ts`.
 */
function record() {
  const events: string[] = [];
  const usage: UsageRecord[][] = [];
  const options = {
    onPartial: (text: string) => events.push(`partial:${text}`),
    onFinal: (text: string) => events.push(`final:${text}`),
    onUsage: (records: UsageRecord[]) => {
      events.push("usage");
      usage.push(records);
    },
    onEnd: () => events.push("end"),
    onError: (err: Error) => events.push(`error:${err.message}`),
  };
  return { events, usage, options };
}

/** A `transcribe` whose call is held open until the test settles it. */
function deferred() {
  const calls: { wav: Uint8Array; signal: AbortSignal }[] = [];
  let settle!: { resolve: (text: string) => void; reject: (err: Error) => void };
  const transcribe: BatchTranscribe = (wav, signal) => {
    calls.push({ wav, signal });
    return new Promise((resolve, reject) => {
      settle = { resolve: (text) => resolve({ text, usage: [] }), reject };
    });
  };
  return { calls, transcribe, settle: () => settle };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("buffers every chunk and makes exactly one call, with the whole clip, on finish", async () => {
  const { calls, transcribe, settle } = deferred();
  const { events, options } = record();
  const session = createBatchSession(options, transcribe);

  session.sendAudio(Buffer.from([1, 2]));
  session.sendAudio(Buffer.from([3, 4]));
  expect(calls).toHaveLength(0);

  session.finish();
  session.finish();
  session.sendAudio(Buffer.from([5, 6])); // after finish: ignored
  expect(calls).toHaveLength(1);

  // A WAV is a 44-byte header followed by the PCM, unchanged.
  const wav = calls[0]!.wav;
  expect(Buffer.from(wav.subarray(0, 4)).toString("ascii")).toBe("RIFF");
  expect([...wav.subarray(44)]).toEqual([1, 2, 3, 4]);

  settle().resolve("hello");
  await flush();
  expect(events).toEqual(["final:hello", "end"]);
});

test("reports usage between the final and the end, and skips it when there is nothing to bill", async () => {
  const billed = record();
  const records = [{ sku: "vendor:model:seconds", unitPrice: 0.01, quantity: 2 }];
  const withUsage = createBatchSession(billed.options, async () => ({ text: "a", usage: records }));
  withUsage.finish();
  await flush();
  expect(billed.events).toEqual(["final:a", "usage", "end"]);
  expect(billed.usage).toEqual([records]);

  const free = record();
  const withoutUsage = createBatchSession(free.options, async () => ({ text: "b", usage: [] }));
  withoutUsage.finish();
  await flush();
  expect(free.events).toEqual(["final:b", "end"]);
});

test("a thrown error is reported through onError, with no final or end", async () => {
  const { events, options } = record();
  const session = createBatchSession(options, async () => {
    throw new Error("vendor said no");
  });
  session.finish();
  await flush();
  expect(events).toEqual(["error:vendor said no"]);
});

test("close() aborts the in-flight call and silences everything after it", async () => {
  const { calls, transcribe, settle } = deferred();
  const { events, options } = record();
  const session = createBatchSession(options, transcribe);
  session.finish();

  session.close();
  expect(calls[0]!.signal.aborted).toBe(true);

  // Whether the vendor call then fails (the usual result of an abort) or
  // succeeds anyway, the caller already hung up and hears nothing.
  settle().resolve("too late");
  await flush();
  expect(events).toEqual([]);

  const failed = deferred();
  const failedEvents = record();
  const failing = createBatchSession(failedEvents.options, failed.transcribe);
  failing.finish();
  failing.close();
  failed.settle().reject(new Error("aborted"));
  await flush();
  expect(failedEvents.events).toEqual([]);
});

test("close() before finish means no call is ever made", async () => {
  const { calls, transcribe } = deferred();
  const { events, options } = record();
  const session = createBatchSession(options, transcribe);
  session.sendAudio(Buffer.from([1, 2]));
  session.close();
  session.finish();
  await flush();
  expect(calls).toHaveLength(0);
  expect(events).toEqual([]);
});
