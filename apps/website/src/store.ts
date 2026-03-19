import { atom } from "nanostores";

export interface Message {
  id: string;
  status: "recording" | "done" | "error";
  partial?: string;
  final?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

const BACKEND_URL_KEY = "vxbeamer_backend_url";
const SESSION_TOKEN_KEY = "vxbeamer_access_token";
const WAKE_LOCK_KEY = "vxbeamer_wake_lock";

function loadSessionToken(): string | null {
  const token = localStorage.getItem(SESSION_TOKEN_KEY);
  if (!token) return null;
  try {
    const payload = JSON.parse(
      atob(token.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/")),
    ) as { exp: number };
    if (payload.exp <= Math.floor(Date.now() / 1000)) {
      localStorage.removeItem(SESSION_TOKEN_KEY);
      return null;
    }
  } catch {
    localStorage.removeItem(SESSION_TOKEN_KEY);
    return null;
  }
  return token;
}

export const $wakeLockEnabled = atom<boolean>(localStorage.getItem(WAKE_LOCK_KEY) === "true");

export function setWakeLockEnabled(enabled: boolean): void {
  $wakeLockEnabled.set(enabled);
  localStorage.setItem(WAKE_LOCK_KEY, String(enabled));
}

export const $backendUrl = atom<string>(
  localStorage.getItem(BACKEND_URL_KEY) ?? window.location.origin,
);

export const $sessionToken = atom<string | null>(loadSessionToken());

export const $messages = atom<Message[]>([]);

export const $sseStatus = atom<"disconnected" | "connecting" | "connected">("disconnected");

export function setBackendUrl(url: string): void {
  $backendUrl.set(url);
  localStorage.setItem(BACKEND_URL_KEY, url);
}

export function saveSessionToken(token: string): void {
  $sessionToken.set(token);
  localStorage.setItem(SESSION_TOKEN_KEY, token);
  scheduleTokenRefresh(token);
}

export function clearSessionToken(): void {
  $sessionToken.set(null);
  localStorage.removeItem(SESSION_TOKEN_KEY);
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleTokenRefresh(token: string): void {
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  let exp: number;
  try {
    const payload = JSON.parse(
      atob(token.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/")),
    ) as { exp: number };
    exp = payload.exp;
  } catch {
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  const refreshAt = exp - 3600; // 1 hour before expiry
  const delayMs = Math.max(0, (refreshAt - now) * 1000);
  refreshTimer = setTimeout(() => void refreshToken(), delayMs);
}

async function refreshToken(): Promise<void> {
  const token = $sessionToken.get();
  const backendUrl = $backendUrl.get();
  if (!token || !backendUrl) return;
  try {
    const res = await fetch(new URL("/auth/refresh", backendUrl).toString(), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const data = (await res.json()) as { access_token: string };
    saveSessionToken(data.access_token);
  } catch {
    // silently ignore, token remains valid until expiry
  }
}

// Schedule refresh for any token already in storage on page load
const _initialToken = $sessionToken.get();
if (_initialToken) scheduleTokenRefresh(_initialToken);

type SseEvent =
  | { type: "snapshot"; messages: Message[] }
  | { type: "created"; message: Message }
  | { type: "updated"; message: Message }
  | { type: "deleted"; messageId: string };

export function applySSEEvent(raw: unknown): void {
  const event = raw as SseEvent;
  if (event.type === "snapshot") {
    $messages.set(event.messages);
  } else if (event.type === "created") {
    $messages.set([...$messages.get(), event.message]);
  } else if (event.type === "updated") {
    $messages.set($messages.get().map((m) => (m.id === event.message.id ? event.message : m)));
  } else if (event.type === "deleted") {
    $messages.set($messages.get().filter((m) => m.id !== event.messageId));
  }
}
