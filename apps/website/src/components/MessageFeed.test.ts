import { describe, expect, test } from "vite-plus/test";
import {
  getMessageCardInitialScrollLeft,
  getMessageCardSnapAction,
  getMessageFeedScrollBehavior,
  MESSAGE_CARD_ACTION_WIDTH,
  MESSAGE_CARD_SNAP_TOLERANCE,
} from "./messageFeedScroll.ts";

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
