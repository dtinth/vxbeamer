import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "@nanostores/react";
import { $sessionToken, $backendUrl, $wakeLockMode, $wakeLockActive } from "../store.ts";
import { type AudioSource, createMicrophoneSource } from "../audio.ts";
import { SettingsIcon } from "./SettingsIcon.tsx";

export interface RecordingBarProps {
  createAudioSource?: () => AudioSource;
  onOpenSettings?: () => void;
}

export function RecordingBar({
  createAudioSource = createMicrophoneSource,
  onOpenSettings,
}: RecordingBarProps) {
  const authToken = useStore($sessionToken);
  const backendUrl = useStore($backendUrl);
  const wakeLockMode = useStore($wakeLockMode);
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const audioSourceRef = useRef<AudioSource | null>(null);
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
    const audioSource = audioSourceRef.current;
    if (!canvas || !audioSource) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    function draw() {
      if (!canvas || !ctx || !audioSource) return;
      const data = audioSource.getFrequencyData();

      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      if (!data) {
        animFrameRef.current = requestAnimationFrame(draw);
        return;
      }

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

    audioSourceRef.current?.stop();
    audioSourceRef.current = null;
    wsRef.current = null;

    void wakeLockRef.current?.release().catch(() => undefined);
    wakeLockRef.current = null;
    if ($wakeLockMode.get() === "recording") $wakeLockActive.set(false);

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
      const audioSource = createAudioSource();
      audioSourceRef.current = audioSource;

      // Buffer audio while WS is connecting
      const buffer: ArrayBuffer[] = [];
      await audioSource.start((chunk) => {
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(chunk);
        } else {
          buffer.push(chunk);
        }
      });

      const referenceId = crypto.randomUUID();
      const wsUrl = new URL(backendUrl);
      wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
      wsUrl.pathname = "/ws";
      wsUrl.search = "";
      wsUrl.searchParams.set("access_token", authToken);
      wsUrl.searchParams.set("reference_id", referenceId);

      const ws = new WebSocket(wsUrl.toString());
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("WebSocket connection failed"));
      });

      // Flush buffered audio
      for (const chunk of buffer) ws.send(chunk);

      if (wakeLockMode === "recording" || wakeLockMode === "always") {
        try {
          wakeLockRef.current = await navigator.wakeLock.request("screen");
          $wakeLockActive.set(true);
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
      audioSourceRef.current?.stop();
      audioSourceRef.current = null;
    }
  }, [authToken, backendUrl, wakeLockMode, createAudioSource, startVisualizer]);

  const handleToggle = () => {
    if (!canRecord) {
      onOpenSettings?.();
      return;
    }
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

  // Always-on wake lock
  useEffect(() => {
    if (wakeLockMode !== "always") return;
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;
    void navigator.wakeLock
      ?.request("screen")
      .then((s) => {
        if (cancelled) {
          void s.release();
          return;
        }
        sentinel = s;
        $wakeLockActive.set(true);
        s.addEventListener("release", () => $wakeLockActive.set(false));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      void sentinel?.release().catch(() => undefined);
      $wakeLockActive.set(false);
    };
  }, [wakeLockMode]);

  const canRecord = !!authToken;

  return (
    <div className="flex-none border-t border-(--m3-outline-variant) px-4 py-4">
      {error && <p className="text-xs text-(--m3-error) mb-2 text-center">{error}</p>}
      <div className="relative h-32 flex items-center justify-center">
        <canvas
          ref={canvasRef}
          width={600}
          height={128}
          className="absolute inset-0 w-full h-full rounded-xl"
        />
        <button
          onClick={handleToggle}
          className={[
            "relative z-10 w-32 h-32 rounded-full flex items-center justify-center transition-all shadow-lg",
            isRecording
              ? "bg-red-500 scale-110 shadow-red-500/50"
              : canRecord
                ? "bg-(--m3-surface-container-high) hover:bg-(--m3-surface-container-highest) active:scale-95"
                : "bg-(--m3-surface-container-high) hover:bg-(--m3-surface-container-highest) active:scale-95",
          ].join(" ")}
          aria-label={isRecording ? "Stop recording" : canRecord ? "Start recording" : "Open settings"}
        >
          {isRecording ? (
            <span className="w-10 h-10 rounded-md bg-(--m3-on-error)" />
          ) : canRecord ? (
            <span className="w-10 h-10 rounded-full bg-red-500" />
          ) : (
            <SettingsIcon size={40} />
          )}
        </button>
      </div>
    </div>
  );
}
