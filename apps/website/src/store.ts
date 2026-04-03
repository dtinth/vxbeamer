import { atom, computed } from "nanostores";
import { handleDesktopSwipeBehavior, type DesktopSwipeBehavior } from "./desktop.ts";

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
const REFRESH_TOKEN_KEY = "vxbeamer_refresh_token";
const WAKE_LOCK_KEY = "vxbeamer_wake_lock";
const DESKTOP_SWIPE_BEHAVIOR_KEY = "vxbeamer_desktop_swipe_behavior";
const TOKEN_CHECK_INTERVAL_SECONDS = 60; // Check every minute if we need to refresh
// Keep locally triggered swipes pending long enough for the matching SSE echo to arrive.
const PENDING_LOCAL_SWIPE_TIMEOUT_MS = 5000;

interface AccessTokenPayload {
  sub?: string;
  name?: string;
  exp: number;
  iat?: number;
}

function decodeAccessTokenPayload(token: string): AccessTokenPayload | null {
  try {
    const segments = token.split(".");
    if (segments.length !== 3) return null;
    const payloadSegment = segments[1];
    if (!payloadSegment) return null;
    const base64 = payloadSegment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as Partial<AccessTokenPayload>;
    if (typeof payload.exp !== "number") return null;
    if (payload.iat !== undefined && typeof payload.iat !== "number") return null;
    return {
      sub: typeof payload.sub === "string" ? payload.sub : undefined,
      name: typeof payload.name === "string" ? payload.name : undefined,
      exp: payload.exp,
      iat: payload.iat,
    };
  } catch {
    return null;
  }
}

function loadSessionToken(): string | null {
  const token = localStorage.getItem(SESSION_TOKEN_KEY);
  if (!token) return null;
  return token;
}

function loadRefreshToken(): string | null {
  const token = localStorage.getItem(REFRESH_TOKEN_KEY);
  if (!token) return null;
  return token;
}

export type WakeLockMode = "off" | "recording" | "always";

export const $wakeLockMode = atom<WakeLockMode>(
  (localStorage.getItem(WAKE_LOCK_KEY) as WakeLockMode | null) ?? "off",
);

export const $wakeLockActive = atom<boolean>(false);

function loadDesktopSwipeBehavior(): DesktopSwipeBehavior {
  const value = localStorage.getItem(DESKTOP_SWIPE_BEHAVIOR_KEY);
  return value === "copy" || value === "paste" ? value : "none";
}

export const $desktopSwipeBehavior = atom<DesktopSwipeBehavior>(loadDesktopSwipeBehavior());

export function setWakeLockMode(mode: WakeLockMode): void {
  $wakeLockMode.set(mode);
  localStorage.setItem(WAKE_LOCK_KEY, mode);
}

export function setDesktopSwipeBehavior(mode: DesktopSwipeBehavior): void {
  $desktopSwipeBehavior.set(mode);
  localStorage.setItem(DESKTOP_SWIPE_BEHAVIOR_KEY, mode);
}

export const $backendUrl = atom<string>(localStorage.getItem(BACKEND_URL_KEY) ?? "");

export const $sessionToken = atom<string | null>(loadSessionToken());
export const $refreshToken = atom<string | null>(loadRefreshToken());

export const $userInfo = computed($sessionToken, (token) => {
  if (!token) return null;
  const payload = decodeAccessTokenPayload(token);
  if (!payload) return null;
  return { sub: payload.sub, name: payload.name };
});

export const $messages = atom<Message[]>([]);

export const $activeRecordingReferenceId = atom<string | null>(null);

export const $lastSwipedMessage = atom<{ messageId: string; key: number } | null>(null);

export const $sseStatus = atom<"disconnected" | "connecting" | "connected">("disconnected");

let swipeAnimationCounter = 0;
const pendingLocalSwipes = new Set<string>();

export function setBackendUrl(url: string): void {
  $backendUrl.set(url);
  localStorage.setItem(BACKEND_URL_KEY, url);
}

export function saveSessionToken(accessToken: string, refreshToken: string): void {
  $sessionToken.set(accessToken);
  $refreshToken.set(refreshToken);
  localStorage.setItem(SESSION_TOKEN_KEY, accessToken);
  localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  scheduleTokenRefresh();
}

export function clearSessionToken(): void {
  $sessionToken.set(null);
  $refreshToken.set(null);
  localStorage.removeItem(SESSION_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
}

export function setActiveRecordingReferenceId(referenceId: string | null): void {
  $activeRecordingReferenceId.set(referenceId);
}

export function markPendingLocalSwipe(messageId: string): void {
  pendingLocalSwipes.add(messageId);
  setTimeout(() => pendingLocalSwipes.delete(messageId), PENDING_LOCAL_SWIPE_TIMEOUT_MS);
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let pendingRefresh: Promise<void> | null = null;

const FRESH_THRESHOLD_SECONDS = 5 * 60; // 5 minutes
const EXPIRY_BUFFER_SECONDS = 5 * 60; // 5 minutes

function scheduleTokenRefresh(): void {
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  // Check every minute if we need to refresh
  refreshTimer = setTimeout(() => void checkAndRefreshToken(), TOKEN_CHECK_INTERVAL_SECONDS * 1000);
}

export async function obtainSessionToken(): Promise<string> {
  const token = $sessionToken.get();
  if (!token) throw new Error("Not authenticated");

  const payload = decodeAccessTokenPayload(token);
  if (!payload) throw new Error("Invalid session token");

  const nowSeconds = Math.floor(Date.now() / 1000);

  // Zone 1: fresh — return immediately
  if (payload.iat !== undefined && nowSeconds - payload.iat < FRESH_THRESHOLD_SECONDS) {
    return token;
  }

  const secondsUntilExpiry = payload.exp - nowSeconds;

  // Zone 3: near-expiry or expired — blocking refresh
  if (secondsUntilExpiry < EXPIRY_BUFFER_SECONDS) {
    if (!pendingRefresh) {
      pendingRefresh = refreshToken().finally(() => {
        pendingRefresh = null;
      });
    }
    await pendingRefresh;
    const newToken = $sessionToken.get();
    if (!newToken) throw new Error("Failed to obtain a valid session token");
    return newToken;
  }

  // Zone 2: stale — return current token, refresh in background
  if (!pendingRefresh) {
    pendingRefresh = refreshToken().finally(() => {
      pendingRefresh = null;
    });
  }
  return token;
}

async function checkAndRefreshToken(): Promise<void> {
  const token = $sessionToken.get();
  if (!token) return;
  try {
    await obtainSessionToken();
  } catch {
    // obtainSessionToken will handle refresh failures; ignore here
  }
  // Reschedule the next check
  scheduleTokenRefresh();
}

async function refreshToken(): Promise<void> {
  const refreshToken = $refreshToken.get();
  const backendUrl = $backendUrl.get();
  if (!refreshToken || !backendUrl) return;
  try {
    const res = await fetch(new URL("/auth/refresh", backendUrl).toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (res.status === 401) {
      // Token is invalid, clear both tokens
      clearSessionToken();
      return;
    }
    if (!res.ok) {
      // Other error, keep tokens and retry later
      return;
    }
    const data = (await res.json()) as { access_token: string; refresh_token: string };
    saveSessionToken(data.access_token, data.refresh_token);
  } catch {
    // Network error, keep tokens and retry later
  }
}

// Schedule refresh check for any token already in storage on page load
const _initialToken = $sessionToken.get();
if (_initialToken) scheduleTokenRefresh();

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
    const isLocalSwipe = pendingLocalSwipes.delete(event.message.id);
    swipeAnimationCounter += 1;
    $lastSwipedMessage.set({ messageId: event.message.id, key: swipeAnimationCounter });
    if (!isLocalSwipe) {
      const text =
        event.message.final ??
        event.message.partial ??
        (event.message.status === "recording" ? "" : (event.message.error ?? ""));
      void handleDesktopSwipeBehavior($desktopSwipeBehavior.get(), text);
    }
  }
}
