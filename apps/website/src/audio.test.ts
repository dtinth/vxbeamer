import { beforeEach, expect, test, vi } from "vite-plus/test";

beforeEach(() => {
  vi.unstubAllGlobals();
});

test("detects when microphone capture is unavailable", async () => {
  vi.stubGlobal("navigator", {});

  const { isMicrophoneCaptureSupported } = await import("./audio.ts");

  expect(isMicrophoneCaptureSupported()).toBe(false);
});

test("detects when microphone capture is available", async () => {
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn(),
    },
  });

  const { isMicrophoneCaptureSupported } = await import("./audio.ts");

  expect(isMicrophoneCaptureSupported()).toBe(true);
});
