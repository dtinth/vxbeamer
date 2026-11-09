import { useState } from "react";
import { useStore } from "@nanostores/react";
import {
  $audioProcessingMode,
  $autoCopy,
  $backendUrl,
  $desktopSwipeBehavior,
  $recordingButtonSize,
  $sessionToken,
  $transcriptListMode,
  $userInfo,
  $wakeLockMode,
  $wakeLockActive,
  setBackendUrl,
  clearSessionToken,
  setAudioProcessingMode,
  setAutoCopy,
  setDesktopSwipeBehavior,
  setRecordingButtonSize,
  setTranscriptListMode,
  setWakeLockMode,
  saveSessionToken,
  type AudioProcessingMode,
  type RecordingButtonSize,
  type TranscriptListMode,
  type WakeLockMode,
} from "../store.ts";
import { parsePairingLink, redeemPairingCode, scanQrCode, type PairingLink } from "../pairing.ts";
import { SettingsIcon } from "./SettingsIcon.tsx";
import { isDesktopApp, type DesktopSwipeBehavior } from "../desktop.ts";

export interface SettingsSheetProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function SettingsSheet({ open: controlledOpen, onOpenChange }: SettingsSheetProps = {}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const backendUrl = useStore($backendUrl);
  const audioProcessingMode = useStore($audioProcessingMode);
  const autoCopy = useStore($autoCopy);
  const desktopSwipeBehavior = useStore($desktopSwipeBehavior);
  const transcriptListMode = useStore($transcriptListMode);
  const recordingButtonSize = useStore($recordingButtonSize);
  const sessionToken = useStore($sessionToken);
  const userInfo = useStore($userInfo);
  const wakeLockMode = useStore($wakeLockMode);
  const wakeLockActive = useStore($wakeLockActive);
  const [pairInput, setPairInput] = useState("");
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [pendingLink, setPendingLink] = useState<PairingLink | null>(null);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = onOpenChange ?? setUncontrolledOpen;
  const isDesktop = isDesktopApp();

  const redeem = async (link: PairingLink) => {
    setPendingLink(null);
    setPairing(true);
    setPairError(null);
    try {
      const tokens = await redeemPairingCode(link.backendUrl, link.code);
      setBackendUrl(link.backendUrl);
      saveSessionToken(tokens.accessToken, tokens.refreshToken);
      setPairInput("");
      setOpen(false);
    } catch (err) {
      setPairError(err instanceof Error ? err.message : "Pairing failed.");
    } finally {
      setPairing(false);
    }
  };

  const handlePair = async (text: string) => {
    const link = parsePairingLink(text);
    if (!link) {
      setPairError("That is not a pairing link.");
      return;
    }
    // A link can come from anyone, and the backend it names then gets this
    // app's audio and transcripts. Only the backend already in use goes
    // through unasked.
    if (link.backendUrl !== backendUrl) {
      setPairError(null);
      setPendingLink(link);
      return;
    }
    await redeem(link);
  };

  const handleScan = async () => {
    setPairError(null);
    const text = await scanQrCode();
    if (text !== null) await handlePair(text);
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="p-2 rounded-lg hover:bg-(--m3-surface-container-high) transition-colors text-(--m3-on-surface-variant) hover:text-(--m3-on-surface)"
        aria-label="Settings"
      >
        <SettingsIcon size={20} />
      </button>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col justify-end bg-(--m3-scrim)/60 backdrop-blur-sm"
      onClick={() => setOpen(false)}
    >
      <div
        className="bg-(--m3-surface-container-high) rounded-t-2xl px-4 pt-5 pb-10 space-y-5 max-h-[85dvh] overflow-y-auto overscroll-contain"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Settings</h2>
          <button
            onClick={() => setOpen(false)}
            className="p-1 text-(--m3-on-surface-variant) hover:text-(--m3-on-surface) transition-colors"
          >
            ✕
          </button>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-(--m3-on-surface-variant) uppercase tracking-wider">
              Wake Lock
            </span>
            <span
              className={`text-xs ${wakeLockActive ? "text-green-400" : "text-(--m3-on-surface-variant)"}`}
            >
              {wakeLockActive ? "● Active" : "○ Inactive"}
            </span>
          </div>
          <select
            value={wakeLockMode}
            onChange={(e) => setWakeLockMode(e.target.value as WakeLockMode)}
            className="w-full bg-(--m3-surface-container-highest) rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-(--m3-outline) appearance-none"
          >
            <option value="off">Off</option>
            <option value="recording">On while recording</option>
            <option value="always">Always on</option>
          </select>
        </div>

        <div className="space-y-1.5">
          <span className="text-xs font-medium text-(--m3-on-surface-variant) uppercase tracking-wider">
            Audio Processing
          </span>
          <select
            value={audioProcessingMode}
            onChange={(e) => setAudioProcessingMode(e.target.value as AudioProcessingMode)}
            className="w-full bg-(--m3-surface-container-highest) rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-(--m3-outline) appearance-none"
          >
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </div>

        <div className="space-y-1.5">
          <span className="text-xs font-medium text-(--m3-on-surface-variant) uppercase tracking-wider">
            Auto copy
          </span>
          <select
            value={autoCopy ? "on" : "off"}
            onChange={(e) => setAutoCopy(e.target.value === "on")}
            className="w-full bg-(--m3-surface-container-highest) rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-(--m3-outline) appearance-none"
          >
            <option value="off">Off</option>
            <option value="on">Copy my transcripts when they finish</option>
          </select>
          <p className="text-xs text-(--m3-on-surface-variant)">
            Only recordings made on this device. Holding Space always copies on release, whatever
            this is set to.
          </p>
        </div>

        <div className="space-y-1.5">
          <span className="text-xs font-medium text-(--m3-on-surface-variant) uppercase tracking-wider">
            Transcript history
          </span>
          <select
            value={transcriptListMode}
            onChange={(e) => setTranscriptListMode(e.target.value as TranscriptListMode)}
            className="w-full bg-(--m3-surface-container-highest) rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-(--m3-outline) appearance-none"
          >
            <option value="all">Show all</option>
            <option value="latest">Latest 10 only</option>
          </select>
        </div>

        <div className="space-y-1.5">
          <span className="text-xs font-medium text-(--m3-on-surface-variant) uppercase tracking-wider">
            Recording button
          </span>
          <select
            value={recordingButtonSize}
            onChange={(e) => setRecordingButtonSize(e.target.value as RecordingButtonSize)}
            className="w-full bg-(--m3-surface-container-highest) rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-(--m3-outline) appearance-none"
          >
            <option value="default">Default</option>
            <option value="small">Small</option>
            <option value="hidden">Hidden</option>
          </select>
        </div>

        {isDesktop && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-(--m3-on-surface-variant) uppercase tracking-wider">
                Remote swipe action
              </span>
            </div>
            <select
              value={desktopSwipeBehavior}
              onChange={(e) => setDesktopSwipeBehavior(e.target.value as DesktopSwipeBehavior)}
              className="w-full bg-(--m3-surface-container-highest) rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-(--m3-outline) appearance-none"
            >
              <option value="none">Do nothing</option>
              <option value="copy">Copy to clipboard</option>
              <option value="paste">Paste into active application</option>
            </select>
          </div>
        )}

        <div className="pt-1 space-y-2">
          {sessionToken ? (
            <>
              {userInfo && (
                <div className="space-y-1.5">
                  <span className="text-xs font-medium text-(--m3-on-surface-variant) uppercase tracking-wider">
                    Signed in
                  </span>
                  <div className="bg-(--m3-surface-container-highest) rounded-xl px-3 py-2.5 text-sm space-y-1">
                    {userInfo.name && <div className="text-(--m3-on-surface)">{userInfo.name}</div>}
                    {backendUrl && (
                      <div
                        className="text-(--m3-on-surface-variant) text-xs truncate"
                        title={backendUrl}
                      >
                        {backendUrl}
                      </div>
                    )}
                    {userInfo.sub && (
                      <button
                        onClick={() => void navigator.clipboard.writeText(userInfo.sub!)}
                        className="text-(--m3-on-surface-variant) text-xs font-mono hover:text-(--m3-on-surface) transition-colors cursor-pointer truncate"
                        title={userInfo.sub}
                      >
                        {userInfo.sub}
                      </button>
                    )}
                  </div>
                </div>
              )}
              <button
                onClick={() => {
                  clearSessionToken();
                  setOpen(false);
                }}
                className="w-full py-3 rounded-xl bg-(--m3-surface-container-highest) hover:bg-(--m3-surface-bright) text-sm font-medium transition-colors"
              >
                Sign out
              </button>
            </>
          ) : (
            <>
              <div className="space-y-1.5">
                <span className="text-xs font-medium text-(--m3-on-surface-variant) uppercase tracking-wider">
                  Pair with a link
                </span>
                <div className="flex gap-2">
                  <input
                    value={pairInput}
                    onChange={(e) => setPairInput(e.target.value)}
                    className="min-w-0 flex-1 bg-(--m3-surface-container-highest) rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-(--m3-outline)"
                    autoComplete="off"
                    autoCapitalize="off"
                    placeholder="https://your-backend.example.com/pair#…"
                    aria-label="Pairing link"
                  />
                  <button
                    onClick={() => void handlePair(pairInput)}
                    disabled={pairing || pairInput.trim().length === 0}
                    className="px-4 rounded-xl bg-(--m3-primary) text-(--m3-on-primary) text-sm font-semibold hover:bg-(--m3-primary)/90 transition-colors disabled:opacity-50"
                  >
                    {pairing ? "Pairing…" : "Pair"}
                  </button>
                </div>
                <button
                  onClick={() => void handleScan()}
                  disabled={pairing}
                  className="w-full text-sm text-(--m3-on-surface-variant) hover:text-(--m3-on-surface) transition-colors underline disabled:opacity-50"
                >
                  Scan a QR code
                </button>
                {pendingLink && (
                  <div
                    role="alertdialog"
                    aria-label="Confirm pairing"
                    className="space-y-2 rounded-xl bg-(--m3-surface-container-highest) p-3"
                  >
                    <p className="text-sm text-(--m3-on-surface)">
                      Pair with{" "}
                      <span className="font-mono break-all">{pendingLink.backendUrl}</span>?
                    </p>
                    <p className="text-xs text-(--m3-on-surface-variant)">
                      Your recordings and transcripts will go to that server. Only continue if you
                      know it and you opened this link yourself.
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => void redeem(pendingLink)}
                        className="flex-1 py-2 rounded-xl bg-(--m3-primary) text-(--m3-on-primary) text-sm font-semibold"
                      >
                        Pair
                      </button>
                      <button
                        onClick={() => setPendingLink(null)}
                        className="flex-1 py-2 rounded-xl bg-(--m3-surface-container-high) text-sm"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                {pairError && (
                  <p role="alert" className="text-xs text-(--m3-error)">
                    {pairError}
                  </p>
                )}
                <p className="text-xs text-(--m3-on-surface-variant)">
                  Open /pair on your backend, sign in, and copy or scan the link it shows.
                </p>
              </div>
            </>
          )}
        </div>

        <div className="pt-1 border-t border-(--m3-outline-variant)">
          <button
            onClick={() => location.reload()}
            className="w-full mt-4 py-3 rounded-xl bg-(--m3-surface-container-highest) hover:bg-(--m3-surface-bright) text-sm font-medium transition-colors"
          >
            Refresh app
          </button>
        </div>
      </div>
    </div>
  );
}
