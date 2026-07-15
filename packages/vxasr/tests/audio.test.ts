import { describe, expect, test } from "vite-plus/test";
import { BYTES_PER_SECOND, readPcm } from "../src/audio.ts";

/** Builds a WAV container around `data`, optionally injecting extra chunks before it. */
function buildWav(
  data: Buffer,
  options: {
    rate?: number;
    bits?: number;
    channels?: number;
    audioFormat?: number;
    extraChunks?: Buffer;
    dataSize?: number;
  } = {},
): Buffer {
  const {
    rate = 16000,
    bits = 16,
    channels = 1,
    audioFormat = 1,
    extraChunks = Buffer.alloc(0),
  } = options;

  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0, "ascii");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(audioFormat, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(rate, 12);
  fmt.writeUInt32LE((rate * channels * bits) / 8, 16); // byte rate
  fmt.writeUInt16LE((channels * bits) / 8, 20); // block align
  fmt.writeUInt16LE(bits, 22);

  const dataHeader = Buffer.alloc(8);
  dataHeader.write("data", 0, "ascii");
  dataHeader.writeUInt32LE(options.dataSize ?? data.length, 4);

  const body = Buffer.concat([Buffer.from("WAVE", "ascii"), fmt, extraChunks, dataHeader, data]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0, "ascii");
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

const samples = Buffer.from([0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x04, 0x00]);

describe("raw PCM", () => {
  test("passes headerless PCM through untouched", () => {
    const audio = readPcm(samples);
    expect(audio.source).toBe("raw");
    expect(audio.pcm).toEqual(samples);
  });

  test("derives duration from the 32000 bytes/sec rate the app captures at", () => {
    expect(readPcm(Buffer.alloc(BYTES_PER_SECOND * 2)).seconds).toBe(2);
  });

  test("rejects an odd byte length, which cannot be whole 16-bit samples", () => {
    expect(() => readPcm(Buffer.alloc(5))).toThrow(/odd byte length/);
  });

  test("rejects empty audio", () => {
    expect(() => readPcm(Buffer.alloc(0))).toThrow(/empty/);
  });
});

describe("WAV", () => {
  test("detects a WAV by content, not by file extension, and strips the header", () => {
    const audio = readPcm(buildWav(samples));
    expect(audio.source).toBe("wav");
    expect(audio.pcm).toEqual(samples);
  });

  test("walks chunks rather than assuming a 44-byte header", () => {
    // A LIST chunk before `data` — common in real files. Slicing at a fixed
    // offset would feed metadata to the model as audio.
    const list = Buffer.concat([
      Buffer.from("LIST", "ascii"),
      (() => {
        const size = Buffer.alloc(4);
        size.writeUInt32LE(4, 0);
        return size;
      })(),
      Buffer.from("INFO", "ascii"),
    ]);
    expect(readPcm(buildWav(samples, { extraChunks: list })).pcm).toEqual(samples);
  });

  test("handles the pad byte after an odd-sized chunk", () => {
    const odd = Buffer.concat([
      Buffer.from("note", "ascii"),
      (() => {
        const size = Buffer.alloc(4);
        size.writeUInt32LE(3, 0);
        return size;
      })(),
      Buffer.from([0x61, 0x62, 0x63, 0x00]), // 3 bytes + 1 pad
    ]);
    expect(readPcm(buildWav(samples, { extraChunks: odd })).pcm).toEqual(samples);
  });

  test("takes the rest of the file when a streamed WAV never backfilled its data size", () => {
    expect(readPcm(buildWav(samples, { dataSize: 0 })).pcm).toEqual(samples);
  });

  test.for([
    [{ rate: 44100 }, /44100 Hz/],
    [{ channels: 2 }, /2ch/],
    [{ bits: 8 }, /8-bit/],
  ] as const)("rejects a WAV that is not 16 kHz/16-bit/mono: %o", ([options, expected]) => {
    expect(() => readPcm(buildWav(samples, options))).toThrow(expected);
  });

  test("rejects compressed WAV rather than feeding the model garbage", () => {
    expect(() => readPcm(buildWav(samples, { audioFormat: 3 }))).toThrow(/not uncompressed PCM/);
  });

  test("rejects a RIFF file that is not WAVE", () => {
    const riff = Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      Buffer.alloc(4),
      Buffer.from("AVI ", "ascii"),
    ]);
    expect(() => readPcm(riff)).toThrow(/missing WAVE marker/);
  });

  test("rejects a WAV with no data chunk", () => {
    const noData = readPcm.bind(
      null,
      Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.alloc(4), Buffer.from("WAVE", "ascii")]),
    );
    expect(noData).toThrow(/no data chunk/);
  });
});
