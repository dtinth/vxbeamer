import { expect, test } from "vite-plus/test";
import type { WSMessageReceive } from "hono/ws";
import { isStopMessage, readAudioFrame } from "./wsFrame.ts";

const frame = (data: unknown) => data as WSMessageReceive;

test("reads an ArrayBuffer as its bytes", () => {
  const audio = readAudioFrame(frame(new Uint8Array([1, 2, 3, 4]).buffer));
  expect(audio).not.toBeNull();
  expect([...audio!]).toEqual([1, 2, 3, 4]);
});

test("honours a typed-array view's window into a larger buffer", () => {
  // A view over the middle of a backing buffer: copying the whole buffer would
  // send the neighbouring bytes, which is the exact bug this guards against.
  const backing = new Uint8Array([9, 9, 1, 2, 3, 9]);
  const view = new Uint8Array(backing.buffer, 2, 3);

  const audio = readAudioFrame(frame(view));

  expect([...audio!]).toEqual([1, 2, 3]);
});

test("an empty binary frame is an empty buffer, not null", () => {
  const audio = readAudioFrame(frame(new ArrayBuffer(0)));
  expect(audio).not.toBeNull();
  expect(audio!.length).toBe(0);
});

test("a text frame is not audio", () => {
  expect(readAudioFrame(frame(JSON.stringify({ type: "stop" })))).toBeNull();
});

test("recognises the stop control message", () => {
  expect(isStopMessage(frame(JSON.stringify({ type: "stop" })))).toBe(true);
});

test("a different control message is not a stop", () => {
  expect(isStopMessage(frame(JSON.stringify({ type: "start" })))).toBe(false);
});

test("a binary frame is not a stop message", () => {
  expect(isStopMessage(frame(new Uint8Array([1, 2, 3]).buffer))).toBe(false);
});

test("a malformed text frame is not a stop message", () => {
  expect(isStopMessage(frame("not json{"))).toBe(false);
});
