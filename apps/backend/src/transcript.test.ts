import { expect, test } from "vite-plus/test";
import { normalizeTranscriptText } from "./transcript.ts";

test("normalizeTranscriptText removes trailing whitespace from each line", () => {
  expect(normalizeTranscriptText("First line  \nSecond line\t \nThird line\t")).toBe(
    "First line\nSecond line\nThird line",
  );
});

test("normalizeTranscriptText preserves leading whitespace and internal blank lines", () => {
  expect(normalizeTranscriptText("  Indented line  \r\n\r\n  Another line\t \r\n\r\n")).toBe(
    "  Indented line\r\n\r\n  Another line",
  );
});

test("normalizeTranscriptText removes trailing newlines at the end of the string", () => {
  expect(normalizeTranscriptText("Line\n")).toBe("Line");
});
