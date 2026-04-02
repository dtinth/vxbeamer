import { atom } from "nanostores";

export interface Message {
  id: string;
  referenceId?: string;
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

interface AccessTokenPayload {
  exp: number;
  iat?: number;
}

function decodeAccessTokenPayload(token: string): AccessTokenPayload | null {
  try {
    const payloadSegment = token.split(".")[1];
    if (!payloadSegment) return null;
    const base64 = payloadSegment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as Partial<AccessTokenPayload>;
    if (typeof payload.exp !== "number") return null;
    if (payload.iat !== undefined && typeof payload.iat !== "number") return null;
    return { exp: payload.exp, iat: payload.iat };
  } catch {
    return null;
  }
}

function loadSessionToken(): string | null {
  const token = localStorage.getItem(SESSION_TOKEN_KEY);
  if (!token) return null;
  const payload = decodeAccessTokenPayload(token);
  if (!payload || payload.exp <= Math.floor(Date.now() / 1000)) {
    localStorage.removeItem(SESSION_TOKEN_KEY);
    return null;
  }
  return token;
}

export type WakeLockMode = "off" | "recording" | "always";

export const $wakeLockMode = atom<WakeLockMode>(
  (localStorage.getItem(WAKE_LOCK_KEY) as WakeLockMode | null) ?? "off",
);

export const $wakeLockActive = atom<boolean>(false);

export function setWakeLockMode(mode: WakeLockMode): void {
  $wakeLockMode.set(mode);
  localStorage.setItem(WAKE_LOCK_KEY, mode);
}

export const $backendUrl = atom<string>(
  localStorage.getItem(BACKEND_URL_KEY) ?? window.location.origin,
);

export const $sessionToken = atom<string | null>(loadSessionToken());

export const $messages = atom<Message[]>([]);

export const $activeRecordingReferenceId = atom<string | null>(null);

export const $lastSwipedMessage = atom<{ messageId: string; key: number } | null>(null);

export const $sseStatus = atom<"disconnected" | "connecting" | "connected">("disconnected");

let swipeAnimationCounter = 0;

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

export function setActiveRecordingReferenceId(referenceId: string | null): void {
  $activeRecordingReferenceId.set(referenceId);
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleTokenRefresh(token: string): void {
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  const payload = decodeAccessTokenPayload(token);
  if (!payload) return;
  const now = Math.floor(Date.now() / 1000);
  const refreshAt = payload.exp - 3600; // 1 hour before expiry
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
  | { type: "deleted"; messageId: string }
  | { type: "swiped"; message: Message };

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
  } else if (event.type === "swiped") {
    swipeAnimationCounter += 1;
    $lastSwipedMessage.set({ messageId: event.message.id, key: swipeAnimationCounter });
  }
}
