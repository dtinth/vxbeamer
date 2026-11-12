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

test("normalizeTranscriptText fixes Thai encoding mistakes", () => {
  expect(normalizeTranscriptText("เเม่")).toBe("แม่");
  expect(normalizeTranscriptText("เข้ียว")).toBe("เขี้ยว");
});

test("normalizeTranscriptText leaves other scripts and mixed text alone", () => {
  const mixed = "Deploy ไปที่ Railway ปี 2026 日本語 café";
  expect(normalizeTranscriptText(mixed)).toBe(mixed);
});

test("normalizeTranscriptText still trims after fixing Thai", () => {
  expect(normalizeTranscriptText("เเม่ ไป  \nบ้าน\t \n")).toBe("แม่ ไป\nบ้าน");
});
