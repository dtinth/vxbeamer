import { useEffect, useRef } from "react";

export interface DesktopAuthCodeProps {
  payload: string;
  onDone: () => void;
}

export function DesktopAuthCode({ payload, onDone }: DesktopAuthCodeProps) {
  const codeRef = useRef<HTMLDivElement>(null);

  // Auto-copy on mount
  useEffect(() => {
    void navigator.clipboard.writeText(payload);
  }, [payload]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(payload);
    // Brief visual feedback
    if (codeRef.current) {
      const originalBg = codeRef.current.style.backgroundColor;
      codeRef.current.style.backgroundColor = "rgba(76, 175, 80, 0.2)";
      setTimeout(() => {
        if (codeRef.current) codeRef.current.style.backgroundColor = originalBg;
      }, 200);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-(--m3-background) text-(--m3-on-surface)">
      <div className="flex flex-col items-center gap-4 px-6 max-w-md">
        <h1 className="text-2xl font-semibold">Sign-in code</h1>

        <p className="text-center text-sm text-(--m3-on-surface-variant)">
          Copy this code and paste it into the sign-in dialog.
        </p>

        <div
          ref={codeRef}
          className="w-full px-4 py-3 bg-(--m3-surface-variant) border border-(--m3-outline) rounded-lg font-mono text-sm break-all text-center select-all"
        >
          {payload}
        </div>

        <div className="flex gap-3 w-full">
          <button
            onClick={handleCopy}
            className="flex-1 px-4 py-2 bg-(--m3-primary) text-(--m3-on-primary) rounded-lg font-medium text-sm hover:opacity-90 transition-opacity"
          >
            Copy
          </button>
          <button
            onClick={onDone}
            className="flex-1 px-4 py-2 bg-(--m3-secondary-container) text-(--m3-on-secondary-container) rounded-lg font-medium text-sm hover:opacity-90 transition-opacity"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
