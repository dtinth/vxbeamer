import { expect, test } from "vite-plus/test";
import {
  RecorderCore,
  type RecorderAudioSource,
  type RecorderPorts,
  type RecorderRetainer,
} from "./RecorderCore.ts";

interface FakeSource extends RecorderAudioSource {
  stopped: boolean;
  /** Let the pending `start()` settle. */
  finishStart(): void;
  failStart(error: Error): void;
  /** Deliver PCM as the microphone would. */
  emit(bytes: number): void;
}

interface FakeRetainer extends RecorderRetainer {
  referenceId: string;
  chunks: ArrayBuffer[];
  outcome: "open" | "committed" | "discarded";
}

function createHarness(options: { wakeLock?: boolean } = {}) {
  const sources: FakeSource[] = [];
  const retainers: FakeRetainer[] = [];
  const log: string[] = [];
  const wakeLocks: Array<{ released: boolean; grant: () => void }> = [];
  let nextId = 0;

  const ports: RecorderPorts = {
    createAudioSource() {
      let onChunk: (chunk: ArrayBuffer) => void = () => {};
      let resolve: () => void = () => {};
      let reject: (error: Error) => void = () => {};
      const source: FakeSource = {
        stopped: false,
        start(cb) {
          onChunk = cb;
          return new Promise<void>((res, rej) => {
            resolve = res;
            reject = rej;
          });
        },
        stop() {
          source.stopped = true;
        },
        getFrequencyData: () => null,
        finishStart: () => resolve(),
        failStart: (error) => reject(error),
        emit: (bytes) => onChunk(new ArrayBuffer(bytes)),
      };
      sources.push(source);
      return source;
    },
    newReferenceId: () => `rec-${++nextId}`,
    retain(referenceId) {
      const retainer: FakeRetainer = {
        referenceId,
        chunks: [],
        outcome: "open",
        append: (chunk) => void retainer.chunks.push(chunk),
        commit: () => void (retainer.outcome = "committed"),
        discard: () => void (retainer.outcome = "discarded"),
      };
      retainers.push(retainer);
      return retainer;
    },
    beginTranscription: (id) => void log.push(`begin ${id}`),
    sendAudio: (id, chunk) => void log.push(`audio ${id} ${chunk.byteLength}`),
    endTranscription: (id) => void log.push(`end ${id}`),
  };
  if (options.wakeLock) {
    ports.acquireWakeLock = () =>
      new Promise<() => void>((resolve) => {
        const lock = {
          released: false,
          grant: () =>
            resolve(() => {
              lock.released = true;
            }),
        };
        wakeLocks.push(lock);
      });
  }

  const core = new RecorderCore(ports);
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  return { core, sources, retainers, log, wakeLocks, settle };
}

const capturing = (sources: FakeSource[]) => sources.filter((s) => !s.stopped);

test("the switch flips at once, before the microphone has opened", () => {
  const { core } = createHarness();

  core.toggle();

  expect(core.active.value).toBe(true);
  expect(core.status.value).toBe("starting");
  expect(core.activeReferenceId.value).toBeNull();
});

test("Start, Stop, Start in quick succession leaves exactly one recording", async () => {
  const { core, sources, log, settle } = createHarness();

  core.toggle(); // Start: the microphone is still opening
  core.toggle(); // Stop, before it was ever live
  core.toggle(); // Start again
  sources[0]!.finishStart();
  await settle();

  expect(sources).toHaveLength(1);
  expect(capturing(sources)).toHaveLength(1);
  expect(core.active.value).toBe(true);
  expect(core.status.value).toBe("recording");
  expect(core.activeReferenceId.value).toBe("rec-1");
  expect(log).toEqual(["begin rec-1"]);
});

test("a Stop pressed while the microphone is still opening cancels that recording", async () => {
  const { core, sources, retainers, log, settle } = createHarness();

  core.toggle();
  core.toggle();
  expect(core.active.value).toBe(false);
  sources[0]!.finishStart();
  await settle();

  expect(capturing(sources)).toHaveLength(0);
  expect(core.status.value).toBe("idle");
  expect(core.activeReferenceId.value).toBeNull();
  expect(retainers[0]!.outcome).toBe("discarded");
  expect(log).toEqual([]);
});

test("a cancelled recording that already heard audio is kept and finished", async () => {
  const { core, sources, retainers, log, settle } = createHarness();

  core.toggle();
  sources[0]!.emit(3200);
  core.toggle();
  sources[0]!.finishStart();
  await settle();

  expect(sources[0]!.stopped).toBe(true);
  expect(retainers[0]!.outcome).toBe("committed");
  expect(log).toEqual(["begin rec-1", "audio rec-1 3200", "end rec-1"]);
});

test("a stop then start after the first recording is live starts a new one", async () => {
  const { core, sources, settle } = createHarness();

  core.toggle();
  sources[0]!.finishStart();
  await settle();
  core.toggle(); // Stop
  core.toggle(); // Start
  sources[1]!.finishStart();
  await settle();

  expect(sources).toHaveLength(2);
  expect(sources[0]!.stopped).toBe(true);
  expect(capturing(sources)).toEqual([sources[1]]);
  expect(core.activeReferenceId.value).toBe("rec-2");
});

test("audio captured before the microphone reports ready is retained and transcribed", async () => {
  const { core, sources, retainers, log, settle } = createHarness();

  core.toggle();
  sources[0]!.emit(3200);
  sources[0]!.emit(3200);
  sources[0]!.finishStart();
  await settle();

  expect(retainers[0]!.chunks).toHaveLength(2);
  expect(log).toEqual(["begin rec-1", "audio rec-1 3200", "audio rec-1 3200"]);
});

test("stopping releases everything: microphone, transcription, retained audio", async () => {
  const { core, sources, retainers, log, settle } = createHarness();

  core.toggle();
  sources[0]!.finishStart();
  await settle();
  sources[0]!.emit(3200);
  core.toggle();

  expect(sources[0]!.stopped).toBe(true);
  expect(retainers[0]!.outcome).toBe("committed");
  expect(log).toEqual(["begin rec-1", "audio rec-1 3200", "end rec-1"]);
  expect(core.status.value).toBe("idle");
  expect(core.activeReferenceId.value).toBeNull();
});

test("a microphone that fails to start flips the switch back and says why", async () => {
  const { core, sources, retainers, log, settle } = createHarness();

  core.toggle();
  sources[0]!.failStart(new Error("Permission denied"));
  await settle();

  expect(core.active.value).toBe(false);
  expect(core.status.value).toBe("idle");
  expect(core.error.value).toBe("Permission denied");
  expect(retainers[0]!.outcome).toBe("discarded");
  expect(log).toEqual([]);

  core.toggle(); // trying again clears the message
  expect(core.error.value).toBeNull();
});

test("audio from a recording that has already ended is ignored", async () => {
  const { core, sources, log, settle } = createHarness();

  core.toggle();
  sources[0]!.finishStart();
  await settle();
  core.toggle();
  sources[0]!.emit(3200);

  expect(log).toEqual(["begin rec-1", "end rec-1"]);
});

test("the wake lock is held while recording and let go when it stops", async () => {
  const { core, sources, wakeLocks, settle } = createHarness({ wakeLock: true });

  core.toggle();
  sources[0]!.finishStart();
  await settle();
  wakeLocks[0]!.grant();
  await settle();
  expect(wakeLocks[0]!.released).toBe(false);

  core.toggle();
  expect(wakeLocks[0]!.released).toBe(true);
});

test("a wake lock granted after the recording ended is let go at once", async () => {
  const { core, sources, wakeLocks, settle } = createHarness({ wakeLock: true });

  core.toggle();
  sources[0]!.finishStart();
  await settle();
  core.toggle();
  wakeLocks[0]!.grant();
  await settle();

  expect(wakeLocks[0]!.released).toBe(true);
});

test("disposing switches off, and lets go of a microphone once it has opened", async () => {
  const { core, sources, settle } = createHarness();

  core.toggle();
  core.dispose();
  sources[0]!.finishStart();
  await settle();

  expect(sources[0]!.stopped).toBe(true);
});
