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
}

export function clearSessionToken(): void {
  $sessionToken.set(null);
  localStorage.removeItem(SESSION_TOKEN_KEY);
}

type SseEvent =
  | { type: "snapshot"; messages: Message[] }
  | { type: "created"; message: Message }
  | { type: "updated"; message: Message };

export function applySSEEvent(raw: unknown): void {
  const event = raw as SseEvent;
  if (event.type === "snapshot") {
    $messages.set(event.messages);
  } else if (event.type === "created") {
    $messages.set([...$messages.get(), event.message]);
  } else if (event.type === "updated") {
    $messages.set($messages.get().map((m) => (m.id === event.message.id ? event.message : m)));
  }
}
