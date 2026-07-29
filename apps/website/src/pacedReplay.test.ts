import { beforeEach, expect, test, vi } from "vite-plus/test";
import { createPacedFrameEmitter, toPacedFrames } from "./pacedReplay.ts";

function bytes(n: number): ArrayBuffer {
  return new ArrayBuffer(n);
}

// --- toPacedFrames ---

test("cuts a single buffer into frames of the requested size", () => {
  const frames = toPacedFrames([bytes(6400)], 3200);

  expect(frames.map((f) => f.byteLength)).toEqual([3200, 3200]);
});

test("the tail frame is short when the total does not divide evenly", () => {
  const frames = toPacedFrames([bytes(4000)], 3200);

  expect(frames.map((f) => f.byteLength)).toEqual([3200, 800]);
});

test("concatenates multiple chunks before cutting, ignoring their own boundaries", () => {
  const frames = toPacedFrames([bytes(1000), bytes(1000), bytes(1000)], 3000);

  expect(frames.map((f) => f.byteLength)).toEqual([3000]);
});

test("empty input yields no frames", () => {
  expect(toPacedFrames([], 3200)).toEqual([]);
});

// --- createPacedFrameEmitter ---

beforeEach(() => {
  vi.useFakeTimers();
});

test("start() emits the first frame immediately, later ones paced by the interval", () => {
  const frames = [bytes(1), bytes(2), bytes(3)];
  const seen: number[] = [];
  const emitter = createPacedFrameEmitter(
    frames,
    100,
    (frame) => seen.push(frame.byteLength),
    () => {},
  );

  emitter.start();
  expect(seen).toEqual([1]);

  vi.advanceTimersByTime(100);
  expect(seen).toEqual([1, 2]);

  vi.advanceTimersByTime(100);
  expect(seen).toEqual([1, 2, 3]);
});

test("calls onDone exactly once, after the last frame, with no further onFrame calls", () => {
  const frames = [bytes(1), bytes(2)];
  const seen: number[] = [];
  let doneCount = 0;
  const emitter = createPacedFrameEmitter(
    frames,
    100,
    (frame) => seen.push(frame.byteLength),
    () => doneCount++,
  );

  emitter.start();
  vi.advanceTimersByTime(100); // second (last) frame
  expect(doneCount).toBe(0); // not done yet — the last frame just went out

  vi.advanceTimersByTime(100); // the tick that discovers there's nothing left
  expect(doneCount).toBe(1);
  expect(seen).toEqual([1, 2]);

  vi.advanceTimersByTime(1000);
  expect(doneCount).toBe(1); // no runaway timer, no repeated onDone
});

test("stop() halts replay early and onDone never fires", () => {
  const frames = [bytes(1), bytes(2), bytes(3)];
  const seen: number[] = [];
  let doneCount = 0;
  const emitter = createPacedFrameEmitter(
    frames,
    100,
    (frame) => seen.push(frame.byteLength),
    () => doneCount++,
  );

  emitter.start();
  emitter.stop();
  vi.advanceTimersByTime(1000);

  expect(seen).toEqual([1]); // only the immediate first frame
  expect(doneCount).toBe(0);
});

test("stop() is idempotent", () => {
  const emitter = createPacedFrameEmitter(
    [bytes(1)],
    100,
    () => {},
    () => {},
  );

  emitter.start();
  expect(() => {
    emitter.stop();
    emitter.stop();
  }).not.toThrow();
});

test("start() after stop() does not resume replay", () => {
  const frames = [bytes(1), bytes(2)];
  const seen: number[] = [];
  const emitter = createPacedFrameEmitter(
    frames,
    100,
    (frame) => seen.push(frame.byteLength),
    () => {},
  );

  emitter.start();
  emitter.stop();
  emitter.start();
  vi.advanceTimersByTime(1000);

  expect(seen).toEqual([1]);
});

test("calling start() twice does not restart or double-emit", () => {
  const frames = [bytes(1), bytes(2)];
  const seen: number[] = [];
  const emitter = createPacedFrameEmitter(
    frames,
    100,
    (frame) => seen.push(frame.byteLength),
    () => {},
  );

  emitter.start();
  emitter.start();
  expect(seen).toEqual([1]);
});

test("an empty frame list calls onDone as soon as it starts", () => {
  let doneCount = 0;
  const emitter = createPacedFrameEmitter(
    [],
    100,
    () => {},
    () => doneCount++,
  );

  emitter.start();

  expect(doneCount).toBe(1);
});

test("a custom timers implementation is used instead of the global clock", () => {
  const scheduled: number[] = [];
  let handle = 0;
  const pending = new Map<number, () => void>();
  const timers = {
    setTimeout(callback: () => void, ms: number) {
      scheduled.push(ms);
      const id = ++handle;
      pending.set(id, callback);
      return id;
    },
    clearTimeout(id: number) {
      pending.delete(id);
    },
  };

  const emitter = createPacedFrameEmitter(
    [bytes(1), bytes(2)],
    250,
    () => {},
    () => {},
    timers,
  );
  emitter.start();

  // The global clock never moves; the emitter only proceeds because the
  // injected timer's own callback was fired manually, below.
  expect(scheduled).toEqual([250]);
  expect(pending.size).toBe(1);
  pending.get(1)?.();
  expect(scheduled).toEqual([250, 250]);
});
