import type { AudioProcessingMode } from "./store.ts";

const SAMPLE_RATE = 16000;

const PCM_WORKLET_CODE = `
class PCMProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      const int16 = new Int16Array(channel.length);
      for (let i = 0; i < channel.length; i++) {
        const s = Math.max(-1, Math.min(1, channel[i]));
        int16[i] = s < 0 ? s * 32768 : s * 32767;
      }
      this.port.postMessage(int16.buffer, [int16.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-processor', PCMProcessor);
`;

/**
 * An audio source that produces PCM chunks and frequency data for visualization.
 */
export interface AudioSource {
  /** Start capturing audio. Calls `onChunk` with PCM data as it arrives. */
  start(onChunk: (chunk: ArrayBuffer) => void): Promise<void>;
  /** Stop capturing and release resources. */
  stop(): void;
  /** Get frequency data for visualization (0-255 per bin). Returns null if not available. */
  getFrequencyData(): Uint8Array<ArrayBuffer> | null;
}

/**
 * Set this to a URL (e.g. via devtools or `agent-browser storage local set`)
 * to make recording replay that file instead of opening the microphone —
 * `localStorage.setItem("vxbeamer_test_audio_url", "/test-audio-16k.pcm")`.
 * Not exposed in Settings: it exists so a headless/sandboxed browser with no
 * real (or fake) mic device can still exercise the record button end to end,
 * not as a feature end users are meant to reach for.
 */
const TEST_AUDIO_URL_KEY = "vxbeamer_test_audio_url";

/** 100ms at 16 kHz 16-bit mono, matching a live capture's own chunk pace. */
const TEST_AUDIO_CHUNK_BYTES = 3200;
const TEST_AUDIO_CHUNK_MS = 100;

/**
 * Replays a pre-recorded 16 kHz/16-bit/mono headerless PCM file as though it
 * were live microphone input, paced like a real capture rather than dumped —
 * see `testdata/README.md` on why pacing matters for the ASR vendors this
 * feeds into. Same fixture shape as `testdata/test-audio.bin` (used by the
 * vxasr CLI/tests), just served from `public/` instead of read via `fs`,
 * since this one has to reach the browser over `fetch`.
 */
export function createTestAudioSource(url: string): AudioSource {
  let cancelled = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stopTicking = (): void => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };

  return {
    async start(onChunk) {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to load test audio "${url}": ${response.status}`);
      }
      const pcm = await response.arrayBuffer();
      let offset = 0;

      timer = setInterval(() => {
        if (cancelled || offset >= pcm.byteLength) {
          stopTicking();
          return;
        }
        const end = Math.min(offset + TEST_AUDIO_CHUNK_BYTES, pcm.byteLength);
        onChunk(pcm.slice(offset, end));
        offset = end;
      }, TEST_AUDIO_CHUNK_MS);
    },

    stop() {
      cancelled = true;
      stopTicking();
    },

    // No live signal to visualize — the bars just stay empty, which the
    // visualizer already handles for "no data yet".
    getFrequencyData() {
      return null;
    },
  };
}

export function isMicrophoneCaptureSupported(): boolean {
  return (
    typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

/**
 * Creates an AudioSource backed by the browser's getUserMedia API.
 */
export function getMicrophoneAudioConstraints(
  audioProcessing: AudioProcessingMode,
): MediaTrackConstraints {
  return {
    noiseSuppression: audioProcessing === "on",
    echoCancellation: audioProcessing === "on",
    autoGainControl: audioProcessing === "on",
  };
}

export function createMicrophoneSource(audioProcessing: AudioProcessingMode = "on"): AudioSource {
  let stream: MediaStream | null = null;
  let audioCtx: AudioContext | null = null;
  let worklet: AudioWorkletNode | null = null;
  let analyser: AnalyserNode | null = null;
  let frequencyData: Uint8Array<ArrayBuffer> | null = null;

  return {
    async start(onChunk) {
      if (!isMicrophoneCaptureSupported()) {
        throw new Error("Microphone access is not available in this desktop webview.");
      }

      stream = await navigator.mediaDevices.getUserMedia({
        audio: getMicrophoneAudioConstraints(audioProcessing),
      });

      audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });

      const blob = new Blob([PCM_WORKLET_CODE], { type: "application/javascript" });
      const workletUrl = URL.createObjectURL(blob);
      await audioCtx.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl);

      const source = audioCtx.createMediaStreamSource(stream);
      worklet = new AudioWorkletNode(audioCtx, "pcm-processor");
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      frequencyData = new Uint8Array(analyser.frequencyBinCount);

      source.connect(worklet);
      source.connect(analyser);

      worklet.port.onmessage = (evt: MessageEvent<ArrayBuffer>) => {
        onChunk(evt.data);
      };
    },

    stop() {
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      worklet?.disconnect();
      worklet = null;
      analyser = null;
      frequencyData = null;
      void audioCtx?.close();
      audioCtx = null;
    },

    getFrequencyData() {
      if (!analyser || !frequencyData) return null;
      analyser.getByteFrequencyData(frequencyData);
      return frequencyData;
    },
  };
}

/** The microphone, unless a test-audio URL is set — see {@link createTestAudioSource}. */
export function createDefaultAudioSource(audioProcessing: AudioProcessingMode): AudioSource {
  const testAudioUrl = localStorage.getItem(TEST_AUDIO_URL_KEY);
  if (testAudioUrl) return createTestAudioSource(testAudioUrl);
  return createMicrophoneSource(audioProcessing);
}
