import { expect, test } from "vite-plus/test";
import { getMessageFeedScrollBehavior } from "./messageFeedScroll.ts";

test("uses instant scrolling for the initial message load", () => {
  expect(getMessageFeedScrollBehavior(false)).toBe("auto");
});

test("keeps smooth scrolling for subsequent updates", () => {
  expect(getMessageFeedScrollBehavior(true)).toBe("smooth");
});
