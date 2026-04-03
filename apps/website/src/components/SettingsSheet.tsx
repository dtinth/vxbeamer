import { useState } from "react";
import { useStore } from "@nanostores/react";
import {
  $backendUrl,
  $sessionToken,
  $userInfo,
  $wakeLockMode,
  $wakeLockActive,
  setBackendUrl,
  clearSessionToken,
  setWakeLockMode,
  type WakeLockMode,
} from "../store.ts";
import { startSignIn } from "../oidc.ts";

export interface SettingsSheetProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function SettingsSheet({ open: controlledOpen, onOpenChange }: SettingsSheetProps = {}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const backendUrl = useStore($backendUrl);
  const sessionToken = useStore($sessionToken);
  const userInfo = useStore($userInfo);
  const wakeLockMode = useStore($wakeLockMode);
  const wakeLockActive = useStore($wakeLockActive);
  const [urlInput, setUrlInput] = useState(backendUrl);
  const [signingIn, setSigningIn] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = onOpenChange ?? setUncontrolledOpen;

  const handleSignIn = async () => {
    setSigningIn(true);
    const url = urlInput.trim();
    setBackendUrl(url);
    try {
      await startSignIn(url);
    } catch {
      setSigningIn(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="p-2 rounded-lg hover:bg-(--m3-surface-container-high) transition-colors text-(--m3-on-surface-variant) hover:text-(--m3-on-surface)"
        aria-label="Settings"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.1 5l-1.4 1.4M4.9 5l1.4 1.4M12 2v2M12 20v2M2 12h2M20 12h2M4.9 19l1.4-1.4M19.1 19l-1.4-1.4" />
        </svg>
      </button>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col justify-end bg-(--m3-scrim)/60 backdrop-blur-sm"
      onClick={() => setOpen(false)}
    >
      <div
        className="bg-(--m3-surface-container-high) rounded-t-2xl px-4 pt-5 pb-10 space-y-5"
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

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-white/50 uppercase tracking-wider">
            Backend URL
          </span>
          <input
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onBlur={() => setBackendUrl(urlInput.trim())}
            className="w-full bg-(--m3-surface-container-highest) rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-(--m3-outline)"
            autoComplete="off"
            autoCapitalize="off"
          />
        </label>

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
                    {userInfo.sub && (
                      <button
                        onClick={() => void navigator.clipboard.writeText(userInfo.sub!)}
                        className="text-(--m3-on-surface-variant) text-xs font-mono hover:text-(--m3-on-surface) transition-colors cursor-pointer"
                        title="Click to copy"
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
            <button
              onClick={() => void handleSignIn()}
              disabled={signingIn}
              className="w-full py-3 rounded-xl bg-(--m3-primary) text-(--m3-on-primary) text-sm font-semibold hover:bg-(--m3-primary)/90 transition-colors disabled:opacity-50"
            >
              {signingIn ? "Redirecting…" : "Sign in with OIDC"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
