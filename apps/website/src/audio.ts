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
 * Creates an AudioSource backed by the browser's getUserMedia API.
 */
export function createMicrophoneSource(): AudioSource {
  let stream: MediaStream | null = null;
  let audioCtx: AudioContext | null = null;
  let worklet: AudioWorkletNode | null = null;
  let analyser: AnalyserNode | null = null;
  let frequencyData: Uint8Array<ArrayBuffer> | null = null;

  return {
    async start(onChunk) {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });

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
