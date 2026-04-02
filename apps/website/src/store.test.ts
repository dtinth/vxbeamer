import { beforeEach, expect, test } from "vite-plus/test";
import {
  $activeRecordingReferenceId,
  $lastSwipedMessage,
  $messages,
  applySSEEvent,
  setActiveRecordingReferenceId,
} from "./store.ts";

beforeEach(() => {
  $messages.set([]);
  $activeRecordingReferenceId.set(null);
  $lastSwipedMessage.set(null);
});

test("tracks the active recording reference id", () => {
  setActiveRecordingReferenceId("recording-123");
  expect($activeRecordingReferenceId.get()).toBe("recording-123");

  setActiveRecordingReferenceId(null);
  expect($activeRecordingReferenceId.get()).toBeNull();
});

test("records swipe events without mutating the message list", () => {
  const message = {
    id: "message-1",
    referenceId: "recording-123",
    status: "done" as const,
    final: "Hello",
    createdAt: 1,
    updatedAt: 2,
  };

  applySSEEvent({ type: "snapshot", messages: [message] });
  applySSEEvent({ type: "swiped", message });

  expect($messages.get()).toEqual([message]);
  const firstSwipe = $lastSwipedMessage.get();
  expect(firstSwipe).not.toBeNull();
  expect(firstSwipe?.messageId).toBe("message-1");

  applySSEEvent({ type: "swiped", message });
  const secondSwipe = $lastSwipedMessage.get();
  expect(secondSwipe).not.toBeNull();
  expect(secondSwipe?.messageId).toBe("message-1");
  expect(secondSwipe?.key).toBe((firstSwipe?.key ?? 0) + 1);
});
