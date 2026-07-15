/**
 * The one audio format everything here speaks: 16 kHz, 16-bit signed
 * little-endian, mono — what the browser's AudioWorklet captures and what every
 * `ASRProvider` expects. 32000 bytes per second of speech.
 */
export const SAMPLE_RATE = 16000;
export const BITS_PER_SAMPLE = 16;
export const CHANNELS = 1;
export const BYTES_PER_SECOND = (SAMPLE_RATE * BITS_PER_SAMPLE * CHANNELS) / 8;

export interface PcmAudio {
  readonly pcm: Buffer;
  readonly seconds: number;
  /** Whether a WAV container was unwrapped to get here. */
  readonly source: "wav" | "raw";
}

function fail(message: string): never {
  throw new Error(message);
}

/**
 * Reads a WAV container, returning its PCM payload.
 *
 * Chunks are walked rather than assuming the canonical 44-byte header: real
 * files carry `LIST`/`fact` chunks before `data`, and slicing at a fixed offset
 * would feed metadata to the model as if it were audio.
 */
function parseWav(buffer: Buffer): Buffer {
  if (buffer.length < 12) fail("Not a WAV file: too short for a RIFF header");
  if (buffer.toString("ascii", 8, 12) !== "WAVE") fail("Not a WAV file: missing WAVE marker");

  let format: { audioFormat: number; channels: number; rate: number; bits: number } | undefined;
  let offset = 12;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === "fmt ") {
      if (body + 16 > buffer.length) fail("Malformed WAV: fmt chunk is truncated");
      format = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        rate: buffer.readUInt32LE(body + 4),
        bits: buffer.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      if (!format) fail("Malformed WAV: data chunk appears before fmt");
      if (format.audioFormat !== 1) {
        fail(`WAV is not uncompressed PCM (format ${format.audioFormat}); convert it first`);
      }
      if (
        format.rate !== SAMPLE_RATE ||
        format.bits !== BITS_PER_SAMPLE ||
        format.channels !== CHANNELS
      ) {
        fail(
          `WAV is ${format.rate} Hz / ${format.bits}-bit / ${format.channels}ch, but ` +
            `${SAMPLE_RATE} Hz / ${BITS_PER_SAMPLE}-bit / mono is required. ` +
            `Convert with: ffmpeg -i in.wav -ar ${SAMPLE_RATE} -ac ${CHANNELS} -c:a pcm_s16le out.wav`,
        );
      }
      // A `data` size of 0 shows up in streamed WAVs whose length was never
      // backfilled; take the rest of the file rather than returning silence.
      const end = size === 0 ? buffer.length : Math.min(body + size, buffer.length);
      return buffer.subarray(body, end);
    }

    // Chunks are word-aligned: an odd size is followed by a pad byte.
    offset = body + size + (size % 2);
  }

  fail("Malformed WAV: no data chunk");
}

/**
 * Accepts either a WAV container or headerless PCM, returning raw PCM ready for
 * `sendAudio`. WAV is detected by its magic bytes rather than by file
 * extension, so a mislabelled file still works.
 */
export function readPcm(buffer: Buffer): PcmAudio {
  const isWav = buffer.length >= 4 && buffer.toString("ascii", 0, 4) === "RIFF";
  const pcm = isWav ? parseWav(buffer) : buffer;

  if (pcm.length === 0) fail("Audio is empty");
  if (pcm.length % 2 !== 0) {
    fail(`Raw PCM has an odd byte length (${pcm.length}); 16-bit samples cannot be odd-sized`);
  }

  return { pcm, seconds: pcm.length / BYTES_PER_SECOND, source: isWav ? "wav" : "raw" };
}
