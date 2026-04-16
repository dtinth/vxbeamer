import { describe, expect, test } from "vite-plus/test";
import {
  getMessageCardInitialScrollLeft,
  getMessageCardSnapAction,
  getMessageFeedScrollBehavior,
} from "./messageFeedScroll.ts";

test("uses instant scrolling for the initial message load", () => {
  expect(getMessageFeedScrollBehavior(false)).toBe("auto");
});

test("keeps smooth scrolling for subsequent updates", () => {
  expect(getMessageFeedScrollBehavior(true)).toBe("smooth");
});

describe("message card snap helpers", () => {
  test("centers each card on initial render", () => {
    expect(getMessageCardInitialScrollLeft()).toBe(96);
  });

  test("recognizes a right swipe when snapped to the leading action", () => {
    expect(getMessageCardSnapAction(0)).toBe("swipe-right");
    expect(getMessageCardSnapAction(20)).toBe("swipe-right");
  });

  test("recognizes a left swipe when snapped to the trailing action", () => {
    expect(getMessageCardSnapAction(192)).toBe("swipe-left");
    expect(getMessageCardSnapAction(176)).toBe("swipe-left");
  });

  test("stays centered when no action snap point was reached", () => {
    expect(getMessageCardSnapAction(96)).toBeNull();
    expect(getMessageCardSnapAction(140)).toBeNull();
  });
});
