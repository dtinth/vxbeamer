import { concatChunks } from "./recordedAudio.ts";

/**
 * Replays recorded PCM the way a live capture would have produced it —
 * fixed-size frames, one per tick — instead of dumping a whole clip at once.
 * Pacing matters to the ASR vendors this feeds: BytePlus's bi-directional
 * mode hangs outright on a fast dump, and Qwen returns a different transcript
 * (`testdata/README.md`, dtinth/vxbeamer#38).
 *
 * `evalRun.ts` (fan an eval out to every configuration in parallel) and
 * `audio.ts` (replay a file as though it were the microphone, for testing
 * without one — dtinth/vxbeamer#86) both needed exactly this, and had each
 * grown their own copy before this module existed.
 */

export interface PacedReplayTimers {
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

const defaultTimers: PacedReplayTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms) as unknown as number,
  clearTimeout: (handle) => clearTimeout(handle),
};

/**
 * Re-cuts captured PCM into fixed-size frames.
 *
 * The AudioWorklet hands over 128-sample chunks — 256 bytes, 8 ms each —
 * which is a render-quantum artefact, not a wire format. Replaying those one
 * per tick would stretch a 9 s clip over several minutes, so the audio is
 * concatenated and re-cut to `frameBytes`. The last frame is short whenever
 * the clip does not divide evenly; a vendor takes it as the tail it is.
 */
export function toPacedFrames(chunks: readonly ArrayBuffer[], frameBytes: number): ArrayBuffer[] {
  const joined = concatChunks(chunks);
  const total = joined.byteLength;

  const frames: ArrayBuffer[] = [];
  for (let start = 0; start < total; start += frameBytes) {
    frames.push(joined.slice(start, Math.min(start + frameBytes, total)).buffer);
  }
  return frames;
}

export interface PacedFrameEmitter {
  /** Begin ticking. A no-op if already started or stopped. */
  start(): void;
  /** Stop ticking, whether or not every frame has gone out yet. Idempotent. */
  stop(): void;
}

/**
 * Emits `frames` one at a time, `intervalMs` apart, starting only once
 * {@link PacedFrameEmitter.start} is called — a caller that must wait for a
 * socket to be ready before the first frame goes out needs that separation
 * from construction. Calls `onDone` once every frame has gone out; never
 * calls it if `stop()` cut the replay short.
 */
export function createPacedFrameEmitter(
  frames: readonly ArrayBuffer[],
  intervalMs: number,
  onFrame: (frame: ArrayBuffer, index: number) => void,
  onDone: () => void,
  timers: PacedReplayTimers = defaultTimers,
): PacedFrameEmitter {
  let index = 0;
  let timer: number | null = null;
  let started = false;
  let stopped = false;

  const clearTimer = (): void => {
    if (timer === null) return;
    timers.clearTimeout(timer);
    timer = null;
  };

  const tick = (): void => {
    if (stopped) return;
    if (index >= frames.length) {
      stopped = true;
      onDone();
      return;
    }
    onFrame(frames[index]!, index);
    index += 1;
    timer = timers.setTimeout(tick, intervalMs);
  };

  return {
    start() {
      if (started || stopped) return;
      started = true;
      tick();
    },
    stop() {
      stopped = true;
      clearTimer();
    },
  };
}
