import { useEffect, useState } from "react";
import { useStore } from "@nanostores/react";
import {
  $sessionToken,
  $backendUrl,
  $sseStatus,
  applySSEEvent,
  saveSessionToken,
  setBackendUrl,
  clearSessionToken,
} from "./store.ts";
import { MessageFeed } from "./components/MessageFeed.tsx";
import { RecordingBar } from "./components/RecordingBar.tsx";
import { SettingsSheet } from "./components/SettingsSheet.tsx";
import { handleCallback } from "./oidc.ts";

export function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const authToken = useStore($sessionToken);
  const backendUrl = useStore($backendUrl);
  const sseStatus = useStore($sseStatus);

  // Handle OIDC callback on mount
  useEffect(() => {
    void handleCallback()
      .then((result) => {
        if (result) {
          saveSessionToken(result.accessToken);
          setBackendUrl(result.backendUrl);
        }
      })
      .catch((err: unknown) => {
        console.error("Auth error:", err);
        clearSessionToken();
      });
  }, []);

  // SSE connection
  useEffect(() => {
    if (!authToken || !backendUrl) {
      $sseStatus.set("disconnected");
      return;
    }

    $sseStatus.set("connecting");
    const url = new URL("/sse", backendUrl);
    url.searchParams.set("access_token", authToken);

    const sse = new EventSource(url.toString());
    sse.onopen = () => $sseStatus.set("connected");
    sse.onmessage = (evt) => {
      try {
        applySSEEvent(JSON.parse(evt.data as string));
      } catch {
        // ignore malformed events
      }
    };
    sse.onerror = () => $sseStatus.set("disconnected");

    return () => {
      sse.close();
      $sseStatus.set("disconnected");
    };
  }, [authToken, backendUrl]);

  const statusColor =
    sseStatus === "connected"
      ? "bg-green-400"
      : sseStatus === "connecting"
        ? "bg-(--m3-primary) animate-pulse"
        : "bg-(--m3-error)";

  return (
    <div
      className="flex flex-col bg-(--m3-background) text-(--m3-on-surface) overflow-hidden"
      style={{
        height: "100svh",
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      <header className="flex-none px-4 py-3 flex items-center justify-between border-b border-(--m3-outline-variant)">
        <h1 className="text-lg font-semibold tracking-tight">vxbeamer</h1>
        <div className="flex items-center gap-3">
          <span className={`w-2 h-2 rounded-full ${statusColor}`} title={sseStatus} />
          <SettingsSheet open={settingsOpen} onOpenChange={setSettingsOpen} />
        </div>
      </header>
      <MessageFeed onOpenSettings={() => setSettingsOpen(true)} />
      <RecordingBar onOpenSettings={() => setSettingsOpen(true)} />
    </div>
  );
}
