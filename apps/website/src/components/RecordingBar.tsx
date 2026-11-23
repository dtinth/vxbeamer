import { useCallback, useEffect, useRef } from "react";
import { effect } from "@preact/signals-core";
import { useStore } from "@nanostores/react";
import {
  $audioProcessingMode,
  $recordingButtonSize,
  $sessionToken,
  $backendUrl,
  $wakeLockMode,
  $wakeLockActive,
  setActiveRecordingReferenceId,
} from "../store.ts";
import { type AudioSource, createDefaultAudioSource } from "../audio.ts";
import { retainRecording } from "../recordedAudio.ts";
import {
  beginRecordingConnection,
  endRecordingConnection,
  sendRecordingAudio,
} from "../recordingConnection.ts";
import { RecorderCore, type RecorderPorts } from "../core/RecorderCore.ts";
import { useSignalValue } from "../useSignalValue.ts";
import { SettingsIcon } from "./SettingsIcon.tsx";

export interface RecordingBarProps {
  createAudioSource?: () => AudioSource;
  onOpenSettings?: () => void;
}

/**
 * The browser side of the recorder: microphone, backend socket, in-memory audio
 * store and wake lock, handed to {@link RecorderCore} as ports. The core owns
 * every decision; this file only translates.
 */
function createPorts(getCreateAudioSource: () => (() => AudioSource) | undefined): RecorderPorts {
  return {
    createAudioSource: () => {
      const createAudioSource = getCreateAudioSource();
      return createAudioSource
        ? createAudioSource()
        : createDefaultAudioSource($audioProcessingMode.get());
    },
    newReferenceId: () => crypto.randomUUID(),
    // Retain the whole recording in memory (this tab only) so it can be
    // replayed against other models after the fact.
    retain: retainRecording,
    beginTranscription: (referenceId) =>
      beginRecordingConnection(referenceId, $sessionToken.get() ?? "", $backendUrl.get()),
    sendAudio: sendRecordingAudio,
    endTranscription: endRecordingConnection,
    async acquireWakeLock() {
      const mode = $wakeLockMode.get();
      if (mode !== "recording" && mode !== "always") return () => undefined;
      const sentinel = await navigator.wakeLock.request("screen");
      $wakeLockActive.set(true);
      return () => {
        void sentinel.release().catch(() => undefined);
        if ($wakeLockMode.get() === "recording") $wakeLockActive.set(false);
      };
    },
  };
}

export function RecordingBar({ createAudioSource, onOpenSettings }: RecordingBarProps) {
  const authToken = useStore($sessionToken);
  const wakeLockMode = useStore($wakeLockMode);
  const recordingButtonSize = useStore($recordingButtonSize);

  const createAudioSourceRef = useRef(createAudioSource);
  createAudioSourceRef.current = createAudioSource;
  const coreRef = useRef<RecorderCore | null>(null);
  coreRef.current ??= new RecorderCore(createPorts(() => createAudioSourceRef.current));
  const core = coreRef.current;

  const isActive = useSignalValue(core.active);
  const status = useSignalValue(core.status);
  const error = useSignalValue(core.error);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // The rest of the app reads which recording is live from the store.
  useEffect(
    () => effect(() => setActiveRecordingReferenceId(core.activeReferenceId.value)),
    [core],
  );

  // Draw the level bars while a recording is live.
  useEffect(() => {
    if (status !== "recording") return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    let frame = 0;

    function draw() {
      if (!canvas || !ctx) return;
      const data = core.getFrequencyData();
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      if (data) {
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
      }
      frame = requestAnimationFrame(draw);
    }

    draw();
    return () => {
      cancelAnimationFrame(frame);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [core, status]);

  // Leaving the page switches the recorder off.
  useEffect(() => () => core.dispose(), [core]);

  const canRecord = !!authToken;

  const handleToggle = useCallback(() => {
    if (!canRecord) {
      onOpenSettings?.();
      return;
    }
    core.toggle();
  }, [canRecord, core, onOpenSettings]);

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

  // The button is hidden entirely for display-only use — the component stays
  // mounted so an in-progress recording and the always-on wake lock keep going.
  if (recordingButtonSize === "hidden") return null;

  const isSmall = recordingButtonSize === "small";
  const buttonBoxClass = isSmall ? "w-20 h-20" : "w-32 h-32";
  const innerSizeClass = isSmall ? "w-7 h-7" : "w-10 h-10";
  const settingsIconSize = isSmall ? 28 : 40;

  return (
    <div
      className={`flex-none border-t border-(--m3-outline-variant) px-4 ${isSmall ? "py-1.5" : "py-4"}`}
    >
      {error && <p className="text-xs text-(--m3-error) mb-2 text-center">{error}</p>}
      <div className={`relative flex items-center justify-center ${isSmall ? "h-24" : "h-32"}`}>
        <canvas
          ref={canvasRef}
          width={600}
          height={128}
          className="absolute inset-0 w-full h-full rounded-xl"
        />
        <button
          // Lets `r` and hold-Space find and click this exact button (see
          // keyboardShortcuts.ts) — a plain DOM query rather than a prop,
          // since the shortcut listener lives above this component in the
          // tree and has no handler of its own to pass down.
          data-shortcut="record-toggle"
          onClick={handleToggle}
          className={[
            "relative z-10 rounded-full flex items-center justify-center transition-all shadow-lg",
            buttonBoxClass,
            isActive
              ? "bg-red-500 scale-110 shadow-red-500/50"
              : "bg-(--m3-surface-container-high) hover:bg-(--m3-surface-container-highest) active:scale-95",
          ].join(" ")}
          aria-label={isActive ? "Stop recording" : canRecord ? "Start recording" : "Open settings"}
        >
          {isActive ? (
            <span className={`${innerSizeClass} rounded-md bg-(--m3-on-error)`} />
          ) : canRecord ? (
            <span className={`${innerSizeClass} rounded-full bg-red-500`} />
          ) : (
            <SettingsIcon size={settingsIconSize} />
          )}
        </button>
      </div>
    </div>
  );
}
