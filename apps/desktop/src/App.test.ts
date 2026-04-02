import { describe, expect, test } from "vite-plus/test";
import { formatRelativeTime } from "./relativeTime.ts";

describe("formatRelativeTime", () => {
  test("shows recent times in seconds", () => {
    expect(formatRelativeTime(95_000, 100_000)).toBe("5 seconds ago");
  });

  test("shows minute granularity", () => {
    expect(formatRelativeTime(40_000, 100_000)).toBe("1 minute ago");
  });
});
