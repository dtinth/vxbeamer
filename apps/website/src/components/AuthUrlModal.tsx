import { useEffect, useState } from "react";
import { createAuthUrl, exchangeDesktopCode } from "../oidc.ts";

export interface AuthUrlModalProps {
  backendUrl: string;
  onSuccess: (accessToken: string, refreshToken: string) => void;
  onClose: () => void;
}

type Status = "loading" | "ready" | "submitting" | "error";

export function AuthUrlModal({ backendUrl, onSuccess, onClose }: AuthUrlModalProps) {
  const [authUrl, setAuthUrl] = useState("");
  const [codeVerifier, setCodeVerifier] = useState("");
  const [state, setState] = useState("");
  const [paste, setPaste] = useState("");
  const [status, setStatus] = useState<Status>("loading");
  const [errorMessage, setErrorMessage] = useState("");

  // Generate auth URL on mount
  useEffect(() => {
    void (async () => {
      try {
        const result = await createAuthUrl(backendUrl);
        setAuthUrl(result.url);
        setCodeVerifier(result.codeVerifier);
        setState(result.state);
        setStatus("ready");
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : "Failed to generate auth URL");
        setStatus("error");
      }
    })();
  }, [backendUrl]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(authUrl);
  };

  const handleOpen = () => {
    window.open(authUrl, "_blank");
  };

  const handleSubmit = async () => {
    if (!paste.trim()) {
      setErrorMessage("Please paste the code");
      return;
    }

    setStatus("submitting");
    setErrorMessage("");

    try {
      const result = await exchangeDesktopCode(paste, codeVerifier, state, backendUrl);
      onSuccess(result.accessToken, result.refreshToken);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Exchange failed");
      setStatus("ready");
    }
  };

  if (status === "loading") {
    return (
      <div className="fixed inset-0 z-50 bg-(--m3-background)/50 flex items-center justify-center">
        <div className="bg-(--m3-surface) text-(--m3-on-surface) p-6 rounded-lg">Loading...</div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-(--m3-surface) text-(--m3-on-surface) rounded-lg p-6 max-w-md w-full space-y-4">
        <h2 className="text-xl font-semibold">Sign in</h2>

        <p className="text-sm text-(--m3-on-surface-variant)">
          Open the following URL to authenticate.
        </p>

        {/* URL Field */}
        <div className="space-y-2">
          <input
            type="text"
            readOnly
            value={authUrl}
            className="w-full px-3 py-2 bg-(--m3-surface-variant) border border-(--m3-outline) rounded text-sm font-mono text-xs overflow-x-auto"
          />
          <div className="flex gap-2">
            <button
              onClick={handleCopy}
              disabled={status !== "ready"}
              className="flex-1 px-3 py-2 bg-(--m3-primary) text-(--m3-on-primary) rounded text-sm font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
            >
              Copy
            </button>
            <button
              onClick={handleOpen}
              disabled={status !== "ready"}
              className="flex-1 px-3 py-2 bg-(--m3-secondary-container) text-(--m3-on-secondary-container) rounded text-sm font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
            >
              Open
            </button>
          </div>
        </div>

        {/* Paste Field */}
        <div className="space-y-2">
          <label className="text-sm text-(--m3-on-surface-variant)">Paste the code here.</label>
          <input
            type="text"
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            placeholder="code#desktop:..."
            disabled={status !== "ready"}
            className="w-full px-3 py-2 bg-(--m3-surface-variant) border border-(--m3-outline) rounded text-sm disabled:opacity-50"
          />
        </div>

        {/* Error Message */}
        {errorMessage && (
          <div className="px-3 py-2 bg-(--m3-error)/10 border border-(--m3-error) text-(--m3-error) rounded text-sm">
            {errorMessage}
          </div>
        )}

        {/* Buttons */}
        <div className="flex gap-3 pt-4">
          <button
            onClick={onClose}
            disabled={status === "submitting"}
            className="flex-1 px-3 py-2 border border-(--m3-outline) text-(--m3-on-surface) rounded text-sm font-medium disabled:opacity-50 hover:bg-(--m3-surface-variant) transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={status !== "ready"}
            className="flex-1 px-3 py-2 bg-(--m3-primary) text-(--m3-on-primary) rounded text-sm font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
          >
            {status === "submitting" ? "Submitting..." : "Submit"}
          </button>
        </div>
      </div>
    </div>
  );
}
