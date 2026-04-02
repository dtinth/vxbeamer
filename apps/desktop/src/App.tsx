import { invoke } from "@tauri-apps/api/core";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { formatRelativeTime } from "./relativeTime.ts";

type SwipeAction = "none" | "copy" | "paste";
type ConnectionState = "idle" | "connecting" | "connected" | "reconnecting";

interface SwipeEventMessage {
  id: string;
  final?: string;
  partial?: string;
}

interface SwipeEventPayload {
  type: "swiped";
  message: SwipeEventMessage;
}

const BACKEND_URL_KEY = "vxbeamer_desktop_backend_url";
const ACCESS_TOKEN_KEY = "vxbeamer_desktop_access_token";
const SWIPE_ACTION_KEY = "vxbeamer_desktop_swipe_action";
const DEFAULT_BACKEND_URL = "http://localhost:8787";

function readStoredValue(key: string, fallback = ""): string {
  return localStorage.getItem(key) ?? fallback;
}

function readStoredSwipeAction(): SwipeAction {
  const stored = localStorage.getItem(SWIPE_ACTION_KEY);
  return stored === "copy" || stored === "paste" ? stored : "none";
}

function persistSession(backendUrl: string, accessToken: string): void {
  localStorage.setItem(BACKEND_URL_KEY, backendUrl);
  localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
}

function clearPersistedSession(): void {
  localStorage.removeItem(BACKEND_URL_KEY);
  localStorage.removeItem(ACCESS_TOKEN_KEY);
}

function persistSwipeAction(action: SwipeAction): void {
  localStorage.setItem(SWIPE_ACTION_KEY, action);
}

function statusTone(state: ConnectionState): "neutral" | "warning" | "success" {
  if (state === "connected") return "success";
  if (state === "connecting" || state === "reconnecting") return "warning";
  return "neutral";
}

function App() {
  const [backendUrlInput, setBackendUrlInput] = useState(() =>
    readStoredValue(BACKEND_URL_KEY, DEFAULT_BACKEND_URL),
  );
  const [accessTokenInput, setAccessTokenInput] = useState(() => readStoredValue(ACCESS_TOKEN_KEY));
  const [backendUrl, setBackendUrl] = useState(() => readStoredValue(BACKEND_URL_KEY));
  const [accessToken, setAccessToken] = useState(() => readStoredValue(ACCESS_TOKEN_KEY));
  const [swipeAction, setSwipeAction] = useState<SwipeAction>(() => readStoredSwipeAction());
  const [connectionState, setConnectionState] = useState<ConnectionState>(() =>
    readStoredValue(ACCESS_TOKEN_KEY) ? "connecting" : "idle",
  );
  const [lastSwipedAt, setLastSwipedAt] = useState<number | null>(null);
  const [latestMessage, setLatestMessage] = useState("Waiting for swipe events.");
  const [now, setNow] = useState(() => Date.now());
  const swipeActionRef = useRef<SwipeAction>(swipeAction);

  useEffect(() => {
    swipeActionRef.current = swipeAction;
    persistSwipeAction(swipeAction);
  }, [swipeAction]);

  useEffect(() => {
    if (!lastSwipedAt) return;
    const interval = window.setInterval(() => {
      setNow(Date.now());
    }, 1_000);
    return () => window.clearInterval(interval);
  }, [lastSwipedAt]);

  useEffect(() => {
    if (!backendUrl || !accessToken) {
      setConnectionState("idle");
      return;
    }

    setConnectionState("connecting");
    const url = new URL("/sse", backendUrl);
    url.searchParams.set("access_token", accessToken);
    url.searchParams.set("events", "swiped");

    const stream = new EventSource(url.toString());
    stream.onopen = () => {
      setConnectionState("connected");
      setLatestMessage("Listening for swipe events.");
    };
    stream.onerror = () => {
      setConnectionState("reconnecting");
      setLatestMessage("Connection lost. Retrying...");
    };
    stream.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data as string) as SwipeEventPayload;
        if (payload.type !== "swiped") return;
        const text = payload.message.final?.trim() || payload.message.partial?.trim() || "";
        setLastSwipedAt(Date.now());
        void handleSwipe(text, swipeActionRef.current).then(setLatestMessage);
      } catch (error) {
        console.warn("Failed to parse swipe event", error);
        setLatestMessage("Ignored a malformed event.");
      }
    };

    return () => {
      stream.close();
    };
  }, [accessToken, backendUrl]);

  const statusLabel = useMemo(() => {
    if (connectionState === "connected") return "Connected";
    if (connectionState === "connecting") return "Connecting";
    if (connectionState === "reconnecting") return "Reconnecting";
    return "Disconnected";
  }, [connectionState]);

  const lastSwipedLabel = useMemo(() => {
    if (!lastSwipedAt) return "Last swiped: never";
    return `Last swiped: ${formatRelativeTime(lastSwipedAt, now)}`;
  }, [lastSwipedAt, now]);

  function handleSave(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const nextBackendUrl = backendUrlInput.trim();
    const nextAccessToken = accessTokenInput.trim();
    setBackendUrl(nextBackendUrl);
    setAccessToken(nextAccessToken);
    persistSession(nextBackendUrl, nextAccessToken);
    setLatestMessage(nextAccessToken ? "Saved settings." : "Enter an API key to connect.");
  }

  function handleForget(): void {
    setBackendUrl("");
    setAccessToken("");
    setBackendUrlInput(DEFAULT_BACKEND_URL);
    setAccessTokenInput("");
    clearPersistedSession();
    setConnectionState("idle");
    setLatestMessage("Saved credentials cleared.");
  }

  return (
    <main className="app-shell">
      <section className="card">
        <div className="header-row">
          <div>
            <p className="eyebrow">vxbeamer desktop</p>
            <h1>Swipe listener</h1>
          </div>
          <span className={`status-pill tone-${statusTone(connectionState)}`}>{statusLabel}</span>
        </div>

        <div className="status-block">
          <p>{lastSwipedLabel}</p>
          <p className="muted">{latestMessage}</p>
        </div>

        <form className="settings-form" onSubmit={handleSave}>
          <label>
            <span>Backend URL</span>
            <input
              autoComplete="url"
              onChange={(event) => setBackendUrlInput(event.currentTarget.value)}
              placeholder={DEFAULT_BACKEND_URL}
              type="url"
              value={backendUrlInput}
            />
          </label>

          <label>
            <span>API key</span>
            <input
              autoComplete="off"
              onChange={(event) => setAccessTokenInput(event.currentTarget.value)}
              placeholder="Paste your vxbeamer API key"
              type="password"
              value={accessTokenInput}
            />
          </label>

          <fieldset>
            <legend>On swipe</legend>
            <label className="radio-option">
              <input
                checked={swipeAction === "none"}
                name="swipe-action"
                onChange={() => setSwipeAction("none")}
                type="radio"
              />
              <span>
                <strong>None</strong>
                <small>No-op.</small>
              </span>
            </label>
            <label className="radio-option">
              <input
                checked={swipeAction === "copy"}
                name="swipe-action"
                onChange={() => setSwipeAction("copy")}
                type="radio"
              />
              <span>
                <strong>Copy</strong>
                <small>Copy the transcript persistently.</small>
              </span>
            </label>
            <label className="radio-option">
              <input
                checked={swipeAction === "paste"}
                name="swipe-action"
                onChange={() => setSwipeAction("paste")}
                type="radio"
              />
              <span>
                <strong>Paste</strong>
                <small>Copy temporarily, paste, then restore the clipboard.</small>
              </span>
            </label>
          </fieldset>

          <div className="button-row">
            <button type="submit">Save and connect</button>
            <button className="secondary-button" onClick={handleForget} type="button">
              Forget saved key
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}

async function handleSwipe(text: string, action: SwipeAction): Promise<string> {
  if (!text) return "Received a swipe without transcript text.";

  try {
    if (action === "none") {
      return `Swipe received (${text.length} chars).`;
    }
    if (action === "copy") {
      await invoke("copy_text", { text });
      return `Copied ${text.length} characters to the clipboard.`;
    }
    await invoke("paste_text_with_restore", { text });
    return `Pasted ${text.length} characters and restored the clipboard.`;
  } catch (error) {
    return `Swipe action failed: ${errorMessage(error)}`;
  }
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "unknown error";
}

export default App;
