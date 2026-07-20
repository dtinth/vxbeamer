import { afterEach, expect, test, vi } from "vite-plus/test";
import { createIdleWatchdog } from "./idleWatchdog.ts";

afterEach(() => {
  vi.useRealTimers();
});

test("fires once the timeout elapses with no poke", () => {
  vi.useFakeTimers();
  let fired = 0;
  createIdleWatchdog(1000, () => void fired++);

  vi.advanceTimersByTime(999);
  expect(fired).toBe(0);
  vi.advanceTimersByTime(1);
  expect(fired).toBe(1);
});

test("each poke defers the deadline by a full timeout", () => {
  vi.useFakeTimers();
  let fired = 0;
  const watchdog = createIdleWatchdog(1000, () => void fired++);

  for (let i = 0; i < 10; i++) {
    vi.advanceTimersByTime(900);
    watchdog.poke();
  }
  expect(fired).toBe(0);

  vi.advanceTimersByTime(1000);
  expect(fired).toBe(1);
});

test("stop cancels a pending deadline", () => {
  vi.useFakeTimers();
  let fired = 0;
  const watchdog = createIdleWatchdog(1000, () => void fired++);

  watchdog.stop();
  vi.advanceTimersByTime(10_000);
  expect(fired).toBe(0);
});

test("fires at most once, and a later poke does not re-arm it", () => {
  vi.useFakeTimers();
  let fired = 0;
  const watchdog = createIdleWatchdog(1000, () => void fired++);

  vi.advanceTimersByTime(1000);
  expect(fired).toBe(1);

  // A frame racing the teardown must not resurrect a spent watchdog.
  watchdog.poke();
  vi.advanceTimersByTime(10_000);
  expect(fired).toBe(1);
});

test("a non-positive timeout is inert", () => {
  vi.useFakeTimers();
  let fired = 0;
  const zero = createIdleWatchdog(0, () => void fired++);
  const negative = createIdleWatchdog(-1000, () => void fired++);

  zero.poke();
  negative.poke();
  vi.advanceTimersByTime(10_000);
  expect(fired).toBe(0);
});
