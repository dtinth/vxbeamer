/**
 * Streaming linear-interpolation resampler for 16-bit signed little-endian
 * mono PCM.
 *
 * Built for `./providers/openai.ts`: OpenAI's realtime transcription endpoint
 * rejects audio below 24 kHz, but every provider in this package receives
 * 16 kHz PCM from the app's fixed capture pipeline (see `./audio.ts`), so
 * something has to convert one to the other. A first version resampled each
 * flushed chunk independently, which meant every chunk boundary interpolated
 * against a clamped copy of its own last sample instead of the real next
 * sample — a small (~1 sample) discontinuity every ~100ms of audio, for the
 * whole session. This class carries the last input sample as state across
 * calls instead, so a stream fed in many small `push()` calls produces
 * exactly the same output as the same audio fed in one call — see
 * `resample.test.ts`.
 *
 * Deliberately linear rather than sinc/polyphase: resampling only adds
 * information here (this package always upsamples, never downsamples for a
 * vendor), and linear interpolation was enough to produce a clean transcript,
 * loanwords included, against the real OpenAI endpoint. A general ratio
 * rather than a rate pair hardcoded to 16→24 kHz, so the next provider that
 * needs a different rate does not have to write this again.
 */
export class LinearResampler {
  private readonly ratio: number;
  private hasPrev = false;
  private prevSample = 0;
  /** Position, in input-sample units, of `prevSample`. */
  private inputPosition = 0;
  private outputCount = 0;

  constructor(inputRate: number, outputRate: number) {
    if (inputRate <= 0 || outputRate <= 0) {
      throw new Error(`Sample rates must be positive (got ${inputRate} -> ${outputRate})`);
    }
    this.ratio = outputRate / inputRate;
  }

  /**
   * Feed one chunk of PCM, get back its resampled equivalent. Call
   * repeatedly with sequential audio — state persists across calls, so
   * chunking does not affect the result. The first sample of the whole
   * stream is not itself resampled against anything earlier; every audio
   * stream has to start somewhere.
   */
  push(input: Buffer): Buffer {
    const inSamples = input.length / 2;
    if (inSamples === 0) return Buffer.alloc(0);

    const out: number[] = [];

    for (let k = 0; k < inSamples; k++) {
      const sample = input.readInt16LE(k * 2);

      if (!this.hasPrev) {
        this.hasPrev = true;
        this.prevSample = sample;
        this.inputPosition = 0;
        continue;
      }

      const nextPosition = this.inputPosition + 1;
      // Emit every output sample whose source position falls between the
      // previous input sample and this one.
      while (this.outputCount / this.ratio < nextPosition) {
        const sourcePosition = this.outputCount / this.ratio;
        const fraction = sourcePosition - this.inputPosition;
        out.push(Math.round(this.prevSample + (sample - this.prevSample) * fraction));
        this.outputCount++;
      }

      this.prevSample = sample;
      this.inputPosition = nextPosition;
    }

    const buffer = Buffer.allocUnsafe(out.length * 2);
    for (let i = 0; i < out.length; i++) buffer.writeInt16LE(out[i], i * 2);
    return buffer;
  }
}
