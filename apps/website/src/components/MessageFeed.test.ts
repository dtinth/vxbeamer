import { describe, expect, test } from "vite-plus/test";
import type { Message } from "../store.ts";
import {
  canEvalMessage,
  getMessageCardInitialScrollLeft,
  getMessageCardSnapAction,
  getMessageFeedScrollBehavior,
  MESSAGE_CARD_ACTION_WIDTH,
  MESSAGE_CARD_SNAP_TOLERANCE,
  selectVisibleMessages,
} from "./messageFeedScroll.ts";

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: "message-1",
    referenceId: "ref-1",
    status: "done",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("canEvalMessage", () => {
  test("allows eval on a finished message with retained audio", () => {
    expect(canEvalMessage(message(), true)).toBe(true);
  });

  test("refuses eval on a connect-error placeholder, even with retained audio", () => {
    // A `local:<referenceId>` placeholder has no server-side message to
    // submit a winner against — see recordingConnection.ts.
    expect(canEvalMessage(message({ connectionError: true }), true)).toBe(false);
  });

  test("refuses eval while still recording", () => {
    expect(canEvalMessage(message({ status: "recording" }), true)).toBe(false);
  });

  test("refuses eval without retained audio", () => {
    expect(canEvalMessage(message(), false)).toBe(false);
  });
});

test("uses instant scrolling for the initial message load", () => {
  expect(getMessageFeedScrollBehavior(false)).toBe("auto");
});

test("keeps smooth scrolling for subsequent updates", () => {
  expect(getMessageFeedScrollBehavior(true)).toBe("smooth");
});

describe("message card snap helpers", () => {
  // The trailing action is snapped once the card is scrolled to within
  // `tolerance` of its fully-swiped position (both actions scrolled past).
  const leftSnapThreshold = MESSAGE_CARD_ACTION_WIDTH * 2 - MESSAGE_CARD_SNAP_TOLERANCE;

  test("centers each card on initial render", () => {
    const initialScrollLeft = getMessageCardInitialScrollLeft();

    // The card starts scrolled past the leading action, which hides it.
    expect(initialScrollLeft).toBe(MESSAGE_CARD_ACTION_WIDTH);

    // A centered card must not read as snapped to either action.
    expect(getMessageCardSnapAction(initialScrollLeft)).toBeNull();
  });

  test("recognizes a right swipe when snapped to the leading action", () => {
    expect(getMessageCardSnapAction(0)).toBe("swipe-right");
    // The tolerance boundary itself still counts as snapped.
    expect(getMessageCardSnapAction(MESSAGE_CARD_SNAP_TOLERANCE)).toBe("swipe-right");
  });

  test("recognizes a left swipe when snapped to the trailing action", () => {
    expect(getMessageCardSnapAction(MESSAGE_CARD_ACTION_WIDTH * 2)).toBe("swipe-left");
    // The tolerance boundary itself still counts as snapped.
    expect(getMessageCardSnapAction(leftSnapThreshold)).toBe("swipe-left");
  });

  test("stays centered when no action snap point was reached", () => {
    // Just outside either snap zone the card is still considered centered.
    expect(getMessageCardSnapAction(MESSAGE_CARD_SNAP_TOLERANCE + 1)).toBeNull();
    expect(getMessageCardSnapAction(leftSnapThreshold - 1)).toBeNull();
  });

  test("derives snap points from the supplied action width and tolerance", () => {
    // Explicit geometry, independent of the exported constants: with a
    // 100px action and 10px tolerance the snap zones are <=10 and >=190.
    expect(getMessageCardSnapAction(10, 100, 10)).toBe("swipe-right");
    expect(getMessageCardSnapAction(11, 100, 10)).toBeNull();
    expect(getMessageCardSnapAction(189, 100, 10)).toBeNull();
    expect(getMessageCardSnapAction(190, 100, 10)).toBe("swipe-left");
    expect(getMessageCardInitialScrollLeft(100)).toBe(100);
  });
});

describe("selectVisibleMessages", () => {
  const items = Array.from({ length: 15 }, (_, i) => i);

  test("keeps every message when the limit is null", () => {
    expect(selectVisibleMessages(items, null)).toEqual(items);
  });

  test("keeps only the newest messages when a limit is set", () => {
    expect(selectVisibleMessages(items, 10)).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  });

  test("returns everything when there are fewer messages than the limit", () => {
    expect(selectVisibleMessages([1, 2, 3], 10)).toEqual([1, 2, 3]);
  });

  test("does not mutate the input array", () => {
    const original = [1, 2, 3, 4];
    const result = selectVisibleMessages(original, 2);
    expect(result).toEqual([3, 4]);
    expect(original).toEqual([1, 2, 3, 4]);
  });
});
