import { atom, computed } from "nanostores";
import { handleDesktopSwipeBehavior, type DesktopSwipeBehavior } from "./desktop.ts";
import { MemoStore, type FeedEvent, type Message, type SavedAudio } from "./core/MemoStore.ts";
import {
  $retainedRecordings,
  clearRetainedRecordings,
  releaseRetainedRecording,
  setRetainedTranscript,
} from "./recordedAudio.ts";

export type { Message };

const BACKEND_URL_KEY = "vxbeamer_backend_url";
const SESSION_TOKEN_KEY = "vxbeamer_access_token";
const REFRESH_TOKEN_KEY = "vxbeamer_refresh_token";
const WAKE_LOCK_KEY = "vxbeamer_wake_lock";
const AUDIO_PROCESSING_KEY = "vxbeamer_audio_processing";
const DESKTOP_SWIPE_BEHAVIOR_KEY = "vxbeamer_desktop_swipe_behavior";
const TRANSCRIPT_LIST_MODE_KEY = "vxbeamer_transcript_list_mode";
const AUTO_COPY_KEY = "vxbeamer_auto_copy";
const RECORDING_BUTTON_SIZE_KEY = "vxbeamer_recording_button_size";
const TOKEN_CHECK_INTERVAL_SECONDS = 60; // Check every minute if we need to refresh
// Keep locally triggered swipes pending long enough for the matching SSE echo to arrive.
const PENDING_LOCAL_SWIPE_TIMEOUT_MS = 5000;
const RECENT_SWIPE_EVENT_ID_TTL_MS = 30_000;

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
export type AudioProcessingMode = "on" | "off";

export const $wakeLockMode = atom<WakeLockMode>(
  (localStorage.getItem(WAKE_LOCK_KEY) as WakeLockMode | null) ?? "off",
);

export const $wakeLockActive = atom<boolean>(false);

function loadAudioProcessingMode(): AudioProcessingMode {
  return localStorage.getItem(AUDIO_PROCESSING_KEY) === "off" ? "off" : "on";
}

export const $audioProcessingMode = atom<AudioProcessingMode>(loadAudioProcessingMode());

function loadDesktopSwipeBehavior(): DesktopSwipeBehavior {
  const value = localStorage.getItem(DESKTOP_SWIPE_BEHAVIOR_KEY);
  return value === "copy" || value === "paste" ? value : "none";
}

export const $desktopSwipeBehavior = atom<DesktopSwipeBehavior>(loadDesktopSwipeBehavior());

/**
 * Copy a finished transcript to the clipboard without being asked.
 *
 * Only ever applies to a recording made on *this* client: the feed also
 * carries recordings from every other signed-in device, and silently
 * replacing the clipboard with something said on a different phone would be
 * both surprising and hard to trace (dtinth/vxbeamer#86). Off by default,
 * since taking over the clipboard is not something to opt a user into.
 */
export const $autoCopy = atom<boolean>(localStorage.getItem(AUTO_COPY_KEY) === "on");

export function setAutoCopy(enabled: boolean): void {
  $autoCopy.set(enabled);
  localStorage.setItem(AUTO_COPY_KEY, enabled ? "on" : "off");
}

export function setWakeLockMode(mode: WakeLockMode): void {
  $wakeLockMode.set(mode);
  localStorage.setItem(WAKE_LOCK_KEY, mode);
}

export function setAudioProcessingMode(mode: AudioProcessingMode): void {
  $audioProcessingMode.set(mode);
  localStorage.setItem(AUDIO_PROCESSING_KEY, mode);
}

export function setDesktopSwipeBehavior(mode: DesktopSwipeBehavior): void {
  $desktopSwipeBehavior.set(mode);
  localStorage.setItem(DESKTOP_SWIPE_BEHAVIOR_KEY, mode);
}

// How many transcripts the feed keeps on screen. "latest" trims to the newest
// TRANSCRIPT_LIST_LIMIT bubbles; a purely visual, per-browser preference.
export type TranscriptListMode = "all" | "latest";
export const TRANSCRIPT_LIST_LIMIT = 10;

function loadTranscriptListMode(): TranscriptListMode {
  return localStorage.getItem(TRANSCRIPT_LIST_MODE_KEY) === "latest" ? "latest" : "all";
}

export const $transcriptListMode = atom<TranscriptListMode>(loadTranscriptListMode());

export function setTranscriptListMode(mode: TranscriptListMode): void {
  $transcriptListMode.set(mode);
  localStorage.setItem(TRANSCRIPT_LIST_MODE_KEY, mode);
}

export type RecordingButtonSize = "default" | "small" | "hidden";

function loadRecordingButtonSize(): RecordingButtonSize {
  const value = localStorage.getItem(RECORDING_BUTTON_SIZE_KEY);
  return value === "small" || value === "hidden" ? value : "default";
}

export const $recordingButtonSize = atom<RecordingButtonSize>(loadRecordingButtonSize());

export function setRecordingButtonSize(size: RecordingButtonSize): void {
  $recordingButtonSize.set(size);
  localStorage.setItem(RECORDING_BUTTON_SIZE_KEY, size);
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

// The feed: the server's messages joined with this device's saved audio and
// client-only error bubbles. The joining lives in `core/MemoStore.ts`; these
// are the app's handles on its one instance.
const savedAudio = computed($retainedRecordings, (recordings) => {
  const audio = new Map<string, SavedAudio>();
  for (const [referenceId, recording] of recordings) {
    if (recording.chunks.length > 0) {
      audio.set(referenceId, { createdAt: recording.createdAt, transcript: recording.transcript });
    }
  }
  return audio;
});

export const memoStore = new MemoStore({
  audio: savedAudio,
  removeAudio: (referenceIds) => referenceIds.forEach(releaseRetainedRecording),
  rememberTranscript: setRetainedTranscript,
});

export const $messages = memoStore.messages;
export const $localConnectionErrors = memoStore.localConnectionErrors;

/** What the feed actually renders: see {@link MemoStore.memos}. */
export const $visibleMessages = memoStore.memos;

export const $activeRecordingReferenceId = atom<string | null>(null);

export const $lastSwipedMessage = atom<{ messageId: string; key: number } | null>(null);

export const $sseStatus = atom<"disconnected" | "connecting" | "connected">("disconnected");

let swipeAnimationCounter = 0;
const pendingLocalSwipes = new Set<string>();
const recentSwipeEventIds = new Map<string, number>();

function pruneRecentSwipeEventIds(now: number): void {
  for (const [eventId, expiresAt] of recentSwipeEventIds) {
    if (expiresAt <= now) recentSwipeEventIds.delete(eventId);
  }
}

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
  // The session's audio has no owner once the session is gone.
  clearRetainedRecordings();
}

export function setActiveRecordingReferenceId(referenceId: string | null): void {
  $activeRecordingReferenceId.set(referenceId);
}

/**
 * Show (or update) a client-only error bubble for a recording whose `/ws`
 * connect failed or timed out — there is no server-side message to attach an
 * error to yet, since the backend only creates one once the socket opens.
 */
export function setLocalConnectionError(referenceId: string, error: string): void {
  memoStore.setConnectionError(referenceId, error);
}

/** Remove a recording's local connect-error bubble, e.g. once retried successfully. Its audio stays. */
export function clearLocalConnectionError(referenceId: string): void {
  memoStore.clearConnectionError(referenceId);
}

/** This page is delivering the recording itself, so it is not "missing" its transcript. */
export function markLiveRecording(referenceId: string): void {
  memoStore.markLive(referenceId);
}

/** Dismiss a memo that has no server message: its error bubble and its saved audio. */
export function forgetLocalRecording(referenceId: string): void {
  memoStore.forget(referenceId);
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

type SseEvent = FeedEvent | { type: "swiped"; eventId?: string; message: Message };

export function applySSEEvent(raw: unknown, sseEventId?: string): void {
  const event = raw as SseEvent;
  if (
    event.type === "snapshot" ||
    event.type === "created" ||
    event.type === "updated" ||
    event.type === "deleted"
  ) {
    memoStore.applyFeedEvent(event);
  } else if (event.type === "swiped") {
    const swipeEventId = event.eventId ?? sseEventId;
    if (swipeEventId) {
      const now = Date.now();
      pruneRecentSwipeEventIds(now);
      if ((recentSwipeEventIds.get(swipeEventId) ?? 0) > now) return;
      recentSwipeEventIds.set(swipeEventId, now + RECENT_SWIPE_EVENT_ID_TTL_MS);
    }
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
