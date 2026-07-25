import { beforeEach, expect, test, vi } from "vite-plus/test";
import { createStorage } from "./testStorage.ts";

const handleDesktopSwipeBehavior = vi.fn();

vi.mock("./desktop.ts", () => ({
  handleDesktopSwipeBehavior,
}));

function encodeToken(payload: Record<string, unknown>): string {
  const base64 = btoa(JSON.stringify(payload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `header.${base64}.signature`;
}

beforeEach(() => {
  vi.resetModules();
  handleDesktopSwipeBehavior.mockReset();
  vi.unstubAllGlobals();
  vi.stubGlobal("localStorage", createStorage());
  vi.stubGlobal("window", { location: { origin: "https://example.com" } });
});

test("stores and loads session token from localStorage", async () => {
  const { $sessionToken, saveSessionToken, clearSessionToken } = await import("./store.ts");
  const accessToken = encodeToken({ sub: "user-1", exp: Math.floor(Date.now() / 1000) + 3600 });

  saveSessionToken(accessToken, "refresh-token");
  expect($sessionToken.get()).toBe(accessToken);

  clearSessionToken();
  expect($sessionToken.get()).toBeNull();
});

test("stores desktop swipe behavior in localStorage", async () => {
  const { $desktopSwipeBehavior, setDesktopSwipeBehavior } = await import("./store.ts");

  expect($desktopSwipeBehavior.get()).toBe("none");

  setDesktopSwipeBehavior("paste");
  expect($desktopSwipeBehavior.get()).toBe("paste");
});

test("stores audio processing mode in localStorage", async () => {
  const { $audioProcessingMode, setAudioProcessingMode } = await import("./store.ts");

  expect($audioProcessingMode.get()).toBe("on");

  setAudioProcessingMode("off");
  expect($audioProcessingMode.get()).toBe("off");
});

test("stores transcript list mode in localStorage", async () => {
  const { $transcriptListMode, setTranscriptListMode } = await import("./store.ts");

  expect($transcriptListMode.get()).toBe("all");

  setTranscriptListMode("latest");
  expect($transcriptListMode.get()).toBe("latest");
  expect(localStorage.getItem("vxbeamer_transcript_list_mode")).toBe("latest");
});

test("stores recording button size in localStorage", async () => {
  const { $recordingButtonSize, setRecordingButtonSize } = await import("./store.ts");

  expect($recordingButtonSize.get()).toBe("default");

  setRecordingButtonSize("hidden");
  expect($recordingButtonSize.get()).toBe("hidden");
  expect(localStorage.getItem("vxbeamer_recording_button_size")).toBe("hidden");
});

test("backend URL defaults to blank", async () => {
  const { $backendUrl } = await import("./store.ts");

  expect($backendUrl.get()).toBe("");
});

test("releases retained audio once its message is deleted", async () => {
  const [{ applySSEEvent }, { getRetainedRecording, retainRecording }] = await Promise.all([
    import("./store.ts"),
    import("./recordedAudio.ts"),
  ]);

  const retainer = retainRecording("ref-1");
  retainer.append(new ArrayBuffer(4));
  retainer.commit();

  const message = {
    id: "message-1",
    referenceId: "ref-1",
    status: "done" as const,
    final: "Hello",
    createdAt: 1,
    updatedAt: 1,
  };

  applySSEEvent({ type: "created", message });
  expect(getRetainedRecording("ref-1")).toBeDefined();

  applySSEEvent({ type: "deleted", messageId: "message-1" });
  expect(getRetainedRecording("ref-1")).toBeUndefined();
});

test("keeps retained audio while its message has not arrived yet", async () => {
  const [{ $messages }, { getRetainedRecording, retainRecording }] = await Promise.all([
    import("./store.ts"),
    import("./recordedAudio.ts"),
  ]);

  const retainer = retainRecording("ref-1");
  retainer.append(new ArrayBuffer(4));
  retainer.commit();

  // An unrelated message lands before the recording's own message does.
  $messages.set(new Map([["other", { id: "other", status: "done", createdAt: 1, updatedAt: 1 }]]));

  expect(getRetainedRecording("ref-1")).toBeDefined();
});

test("releases retained audio when the session is cleared", async () => {
  const [{ clearSessionToken }, { getRetainedRecording, retainRecording }] = await Promise.all([
    import("./store.ts"),
    import("./recordedAudio.ts"),
  ]);

  const retainer = retainRecording("ref-1");
  retainer.append(new ArrayBuffer(4));
  retainer.commit();

  clearSessionToken();

  expect(getRetainedRecording("ref-1")).toBeUndefined();
});

test("shows and clears a local connection-error placeholder", async () => {
  const { $messages, setLocalConnectionError, clearLocalConnectionError } =
    await import("./store.ts");

  setLocalConnectionError("ref-1", "Connection failed");
  const placeholder = $messages.get().get("local:ref-1");
  expect(placeholder).toMatchObject({
    referenceId: "ref-1",
    status: "error",
    error: "Connection failed",
    connectionError: true,
  });

  clearLocalConnectionError("ref-1");
  expect($messages.get().has("local:ref-1")).toBe(false);
});

test("preserves the placeholder's createdAt across repeated failures", async () => {
  const { $messages, setLocalConnectionError } = await import("./store.ts");

  setLocalConnectionError("ref-1", "Connection failed");
  const firstCreatedAt = $messages.get().get("local:ref-1")?.createdAt;

  setLocalConnectionError("ref-1", "Connection timed out");
  const placeholder = $messages.get().get("local:ref-1");
  expect(placeholder?.error).toBe("Connection timed out");
  expect(placeholder?.createdAt).toBe(firstCreatedAt);
});

test("reconciles away a local connection-error placeholder once the real message arrives", async () => {
  const { $messages, applySSEEvent, setLocalConnectionError } = await import("./store.ts");

  setLocalConnectionError("ref-1", "Connection failed");
  expect($messages.get().has("local:ref-1")).toBe(true);

  applySSEEvent({
    type: "created",
    message: {
      id: "message-1",
      referenceId: "ref-1",
      status: "recording" as const,
      createdAt: 1,
      updatedAt: 1,
    },
  });

  expect($messages.get().has("local:ref-1")).toBe(false);
  expect($messages.get().has("message-1")).toBe(true);
});

test("deduplicates swiped SSE events that reuse the same event id", async () => {
  const { applySSEEvent, setDesktopSwipeBehavior } = await import("./store.ts");

  setDesktopSwipeBehavior("paste");

  const message = {
    id: "message-1",
    status: "done" as const,
    final: "Hello from swipe",
    createdAt: 1,
    updatedAt: 1,
  };

  applySSEEvent({ type: "swiped", eventId: "event-1", message });
  applySSEEvent({ type: "swiped", eventId: "event-1", message });

  expect(handleDesktopSwipeBehavior).toHaveBeenCalledTimes(1);
  expect(handleDesktopSwipeBehavior).toHaveBeenCalledWith("paste", "Hello from swipe");
});
