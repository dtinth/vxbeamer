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
import { DesktopAuthCode } from "./components/DesktopAuthCode.tsx";
import { handleCallback } from "./oidc.ts";

export function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [desktopCallbackPayload, setDesktopCallbackPayload] = useState<string | null>(null);
  const authToken = useStore($sessionToken);
  const backendUrl = useStore($backendUrl);
  const sseStatus = useStore($sseStatus);

  // Handle OIDC callback on mount
  useEffect(() => {
    void handleCallback()
      .then((result) => {
        if (!result) return;
        if (result.type === "session") {
          saveSessionToken(result.accessToken, result.refreshToken);
          setBackendUrl(result.backendUrl);
        } else if (result.type === "desktop") {
          setDesktopCallbackPayload(result.payload);
        }
      })
      .catch((err: unknown) => {
        console.error("Auth error:", err);
        clearSessionToken();
      });
  }, []);

  // SSE connection with heartbeat checking
  useEffect(() => {
    if (!authToken || !backendUrl) {
      $sseStatus.set("disconnected");
      return;
    }

    let sse: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let heartbeatCheckTimer: ReturnType<typeof setInterval> | null = null;
    let lastHeartbeatTime = Date.now();

    const connect = () => {
      $sseStatus.set("connecting");
      const url = new URL("/sse", backendUrl);
      url.searchParams.set("access_token", authToken);

      sse = new EventSource(url.toString());
      lastHeartbeatTime = Date.now();

      sse.onopen = () => {
        $sseStatus.set("connected");
        lastHeartbeatTime = Date.now();
      };

      sse.onmessage = (evt) => {
        lastHeartbeatTime = Date.now();
        try {
          applySSEEvent(JSON.parse(evt.data as string));
        } catch {
          // ignore malformed events
        }
      };

      sse.onerror = () => {
        if (sse) {
          sse.close();
          sse = null;
        }
        $sseStatus.set("disconnected");
        // Reconnect after 2 seconds
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => connect(), 2000);
      };
    };

    // Check heartbeat every 5 seconds
    heartbeatCheckTimer = setInterval(() => {
      if (Date.now() - lastHeartbeatTime > 30_000) {
        // No heartbeat for 30+ seconds, close and reconnect
        if (sse) {
          sse.close();
          sse = null;
        }
        $sseStatus.set("disconnected");
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => connect(), 2000);
      }
    }, 5000);

    connect();

    return () => {
      if (sse) sse.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (heartbeatCheckTimer) clearInterval(heartbeatCheckTimer);
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
    <>
      {desktopCallbackPayload && (
        <DesktopAuthCode
          payload={desktopCallbackPayload}
          onDone={() => setDesktopCallbackPayload(null)}
        />
      )}
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
    </>
  );
}
