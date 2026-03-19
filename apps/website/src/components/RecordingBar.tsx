import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "@nanostores/react";
import { $sessionToken, $backendUrl, $wakeLockEnabled } from "../store.ts";

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

export function RecordingBar() {
  const authToken = useStore($sessionToken);
  const backendUrl = useStore($backendUrl);
  const wakeLockEnabled = useStore($wakeLockEnabled);
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  const stopVisualizer = useCallback(() => {
    if (animFrameRef.current !== null) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    }
  }, []);

  const startVisualizer = useCallback(() => {
    const canvas = canvasRef.current;
    const analyser = analyserRef.current;
    if (!canvas || !analyser) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const data = new Uint8Array(analyser.frequencyBinCount);

    function draw() {
      if (!canvas || !ctx) return;
      analyser!.getByteFrequencyData(data);

      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      const bars = 32;
      const gap = 2;
      const barW = (w - gap * (bars - 1)) / bars;

      for (let i = 0; i < bars; i++) {
        const val = data[Math.floor((i * data.length) / bars)] ?? 0;
        const barH = Math.max(2, (val / 255) * h);
        const alpha = 0.3 + (val / 255) * 0.7;
        ctx.fillStyle = `rgba(239, 68, 68, ${alpha})`;
        const x = i * (barW + gap);
        ctx.fillRect(x, (h - barH) / 2, barW, barH);
      }

      animFrameRef.current = requestAnimationFrame(draw);
    }

    draw();
  }, []);

  const stopRecording = useCallback(() => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "stop" }));
    }

    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    workletRef.current?.disconnect();
    workletRef.current = null;
    analyserRef.current = null;
    void audioCtxRef.current?.close();
    audioCtxRef.current = null;
    wsRef.current = null;

    void wakeLockRef.current?.release().catch(() => undefined);
    wakeLockRef.current = null;

    stopVisualizer();
    setIsRecording(false);
  }, [stopVisualizer]);

  const startRecording = useCallback(async () => {
    if (!authToken) {
      setError("Sign in first");
      return;
    }
    setError(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Set up audio immediately so no audio is lost while WS connects
      const audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
      audioCtxRef.current = audioCtx;

      const blob = new Blob([PCM_WORKLET_CODE], { type: "application/javascript" });
      const workletUrl = URL.createObjectURL(blob);
      await audioCtx.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl);

      const source = audioCtx.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(audioCtx, "pcm-processor");
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyserRef.current = analyser;
      workletRef.current = worklet;

      source.connect(worklet);
      source.connect(analyser);

      // Buffer audio while WS is connecting
      const buffer: ArrayBuffer[] = [];
      worklet.port.onmessage = (evt: MessageEvent<ArrayBuffer>) => {
        buffer.push(evt.data);
      };

      const wsUrl = new URL(backendUrl);
      wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
      wsUrl.pathname = "/ws";
      wsUrl.search = "";
      wsUrl.searchParams.set("access_token", authToken);

      const ws = new WebSocket(wsUrl.toString());
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("WebSocket connection failed"));
      });

      // Flush buffered audio then stream live
      for (const chunk of buffer) ws.send(chunk);
      worklet.port.onmessage = (evt: MessageEvent<ArrayBuffer>) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(evt.data);
      };

      if (wakeLockEnabled) {
        try {
          wakeLockRef.current = await navigator.wakeLock.request("screen");
        } catch {
          // wake lock not available or denied — non-fatal
        }
      }

      setIsRecording(true);
      startVisualizer();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start");
      wsRef.current?.close();
      wsRef.current = null;
      void audioCtxRef.current?.close();
      audioCtxRef.current = null;
    }
  }, [authToken, backendUrl, startVisualizer]);

  const handleToggle = () => {
    if (isRecording) {
      stopRecording();
    } else {
      void startRecording();
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => stopRecording();
  }, [stopRecording]);

  const canRecord = !!authToken;

  return (
    <div className="flex-none border-t border-white/10 px-4 py-4">
      {error && <p className="text-xs text-red-400 mb-2 text-center">{error}</p>}
      <div className="relative h-32 flex items-center justify-center">
        <canvas
          ref={canvasRef}
          width={600}
          height={128}
          className="absolute inset-0 w-full h-full rounded-xl"
        />
        <button
          onClick={handleToggle}
          disabled={!canRecord}
          className={[
            "relative z-10 w-32 h-32 rounded-full flex items-center justify-center transition-all shadow-lg",
            isRecording
              ? "bg-red-500 scale-110 shadow-red-500/50"
              : canRecord
                ? "bg-white/15 hover:bg-white/25 active:scale-95"
                : "bg-white/5 opacity-40 cursor-not-allowed",
          ].join(" ")}
          aria-label={isRecording ? "Stop recording" : "Start recording"}
        >
          {isRecording ? (
            <span className="w-10 h-10 rounded-md bg-white" />
          ) : (
            <span className="w-10 h-10 rounded-full bg-red-500" />
          )}
        </button>
      </div>
    </div>
  );
}
