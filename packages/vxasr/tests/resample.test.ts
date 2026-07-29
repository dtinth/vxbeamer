import { describe, expect, test } from "vite-plus/test";
import { LinearResampler } from "../src/resample.ts";

function pcm(samples: number[]): Buffer {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, i) => buffer.writeInt16LE(sample, i * 2));
  return buffer;
}

function samplesOf(buffer: Buffer): number[] {
  const out: number[] = [];
  for (let i = 0; i < buffer.length / 2; i++) out.push(buffer.readInt16LE(i * 2));
  return out;
}

describe("LinearResampler", () => {
  test("interpolates linearly between known samples", () => {
    const resampler = new LinearResampler(1, 2);

    const out = resampler.push(pcm([0, 1000, 2000]));

    // Each 1-sample gap becomes 2 output samples: the source sample itself,
    // then its midpoint with the next one.
    expect(samplesOf(out)).toEqual([0, 500, 1000, 1500]);
  });

  test("upsamples 16kHz to 24kHz at a 3:2 ratio", () => {
    const resampler = new LinearResampler(16000, 24000);
    // 1600 samples (100ms @ 16kHz) of a simple ramp.
    const input = Array.from({ length: 1600 }, (_, i) => i);

    const out = resampler.push(pcm(input));

    // A causal streaming resampler cannot resolve the very last input sample
    // as an interval endpoint without a following sample that never comes —
    // one fewer than the naive `input.length * 1.5`.
    expect(out.length / 2).toBe(Math.ceil((input.length - 1) * 1.5));
  });

  // --- The bug this class exists to fix ---

  test("chunking the input does not change the output", () => {
    // A deterministic, non-trivial waveform — not a straight ramp, so a bug
    // that only shows up on non-monotonic input would still be caught.
    const samples = Array.from({ length: 500 }, (_, i) =>
      Math.round(10000 * Math.sin(i * 0.37) + 3000 * Math.cos(i * 1.9)),
    );
    const whole = pcm(samples);

    const oneShot = samplesOf(new LinearResampler(16000, 24000).push(whole));

    // Fed one sample at a time — the worst case for a resampler that forgets
    // state between calls.
    const chunked = new LinearResampler(16000, 24000);
    const chunkedSamples: number[] = [];
    for (let i = 0; i < samples.length; i++) {
      chunkedSamples.push(...samplesOf(chunked.push(pcm([samples[i]!]))));
    }

    expect(chunkedSamples).toEqual(oneShot);
  });

  test("arbitrary chunk boundaries still match a one-shot resample", () => {
    const samples = Array.from({ length: 300 }, (_, i) => ((i * 137) % 4000) - 2000);
    const whole = pcm(samples);

    const oneShot = samplesOf(new LinearResampler(16000, 24000).push(whole));

    const resampler = new LinearResampler(16000, 24000);
    const boundaries = [0, 7, 8, 100, 101, 299, 300];
    const chunkedSamples: number[] = [];
    for (let i = 1; i < boundaries.length; i++) {
      const chunk = samples.slice(boundaries[i - 1], boundaries[i]);
      chunkedSamples.push(...samplesOf(resampler.push(pcm(chunk))));
    }

    expect(chunkedSamples).toEqual(oneShot);
  });

  // --- Edge cases ---

  test("an empty chunk produces no output", () => {
    const resampler = new LinearResampler(16000, 24000);

    expect(resampler.push(Buffer.alloc(0)).length).toBe(0);
  });

  test("a single sample with nothing after it produces no output yet", () => {
    const resampler = new LinearResampler(16000, 24000);

    expect(resampler.push(pcm([1234])).length).toBe(0);
  });

  test("rejects a non-positive sample rate", () => {
    expect(() => new LinearResampler(0, 24000)).toThrow(/positive/);
    expect(() => new LinearResampler(16000, -1)).toThrow(/positive/);
  });

  test("downsampling also works — not just this package's upsampling use", () => {
    const resampler = new LinearResampler(2, 1);

    const out = resampler.push(pcm([0, 1000, 2000, 3000]));

    // Every other source sample: position 0 and position 2. Position 4 would
    // be next, but there is no 5th input sample to resolve it against.
    expect(samplesOf(out)).toEqual([0, 2000]);
  });
});
