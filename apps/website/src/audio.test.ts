import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import {
  createDefaultAudioSource,
  createTestAudioSource,
  getMicrophoneAudioConstraints,
} from "./audio.ts";
import { createStorage } from "./testStorage.ts";

test("enables standard WebRTC audio processing when audio processing is on", () => {
  expect(getMicrophoneAudioConstraints("on")).toEqual({
    noiseSuppression: true,
    echoCancellation: true,
    autoGainControl: true,
  });
});

test("disables WebRTC audio processing when audio processing is off", () => {
  expect(getMicrophoneAudioConstraints("off")).toEqual({
    noiseSuppression: false,
    echoCancellation: false,
    autoGainControl: false,
  });
});

function fakeFetchOf(pcm: ArrayBuffer): typeof fetch {
  return (async () => new Response(pcm, { status: 200 })) as unknown as typeof fetch;
}

describe("createTestAudioSource", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  test("replays the file in 100ms/3200-byte chunks, paced like a live capture", async () => {
    const pcm = new ArrayBuffer(6400); // two chunks' worth
    vi.stubGlobal("fetch", fakeFetchOf(pcm));
    const source = createTestAudioSource("/test-audio-16k.pcm");

    const chunks: ArrayBuffer[] = [];
    const started = source.start((chunk) => chunks.push(chunk));
    await vi.advanceTimersByTimeAsync(0); // let the fetch() promise settle
    await started;

    // The first frame goes out the moment replay starts, same as a live
    // capture's first worklet chunk — only the ones after it are paced.
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.byteLength).toBe(3200);
    await vi.advanceTimersByTimeAsync(100);
    expect(chunks).toHaveLength(2);
    expect(chunks[1]?.byteLength).toBe(3200);

    // The file is exhausted — no further chunks, no runaway timer.
    await vi.advanceTimersByTimeAsync(1000);
    expect(chunks).toHaveLength(2);
  });

  test("a short final chunk is still delivered in full", async () => {
    const pcm = new ArrayBuffer(3200 + 800); // one full chunk, one partial
    vi.stubGlobal("fetch", fakeFetchOf(pcm));
    const source = createTestAudioSource("/test-audio-16k.pcm");

    const chunks: ArrayBuffer[] = [];
    await source.start((chunk) => chunks.push(chunk));
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);

    expect(chunks.map((c) => c.byteLength)).toEqual([3200, 800]);
  });

  test("stop() ends replay early — no further chunks arrive", async () => {
    const pcm = new ArrayBuffer(6400);
    vi.stubGlobal("fetch", fakeFetchOf(pcm));
    const source = createTestAudioSource("/test-audio-16k.pcm");

    const chunks: ArrayBuffer[] = [];
    await source.start((chunk) => chunks.push(chunk));
    expect(chunks).toHaveLength(1); // the first frame, sent immediately

    source.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(chunks).toHaveLength(1); // stopped before the second frame's tick
  });

  test("throws if the file fails to load", async () => {
    vi.stubGlobal(
      "fetch",
      (async () => new Response(null, { status: 404 })) as unknown as typeof fetch,
    );
    const source = createTestAudioSource("/missing.pcm");

    await expect(source.start(() => {})).rejects.toThrow(/404/);
  });

  test("has no live signal to visualize", async () => {
    vi.stubGlobal("fetch", fakeFetchOf(new ArrayBuffer(0)));
    const source = createTestAudioSource("/test-audio-16k.pcm");

    expect(source.getFrequencyData()).toBeNull();
  });
});

describe("createDefaultAudioSource", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorage());
  });

  test("replays the configured test file instead of opening the microphone", async () => {
    localStorage.setItem("vxbeamer_test_audio_url", "/custom-test-clip.pcm");
    const fetchSpy = vi.fn(fakeFetchOf(new ArrayBuffer(0)));
    vi.stubGlobal("fetch", fetchSpy);

    const source = createDefaultAudioSource("on");
    await source.start(() => {});

    expect(fetchSpy).toHaveBeenCalledWith("/custom-test-clip.pcm");
  });

  test("falls back to the microphone when no test-audio URL is set", () => {
    // No getUserMedia in this environment, so the real assertion is just that
    // it did not try to fetch a test file — reaching for the mic is the only
    // other thing this function can do.
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    createDefaultAudioSource("on");

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
