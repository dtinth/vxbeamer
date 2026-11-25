import { expect, test } from "vite-plus/test";
import { expandAlternatives, score, tokenize } from "../src/score.ts";

const texts = (text: string) => tokenize(text).map((token) => token.text);

test("a Latin word is one token, and each Thai grapheme cluster is one token", () => {
  // `นี้` keeps its vowel and tone mark; `ต์` keeps its silencing mark.
  expect(texts("ภาษา TypeScript นี้ต์")).toEqual(["ภ", "า", "ษ", "า", "typescript", "นี้", "ต์"]);
});

test("spaces, punctuation and case are not tokens", () => {
  expect(texts("ใช้ MongoDB Atlas.")).toEqual(texts("ใช้mongodb   atlas"));
  // Thai with a space between every word tokenizes the same as without.
  expect(texts("เป็น ผู้ ให้ บริการ")).toEqual(texts("เป็นผู้ให้บริการ"));
});

test("a space that splits a Thai cluster is ignored too, and the token keeps its place in the text", () => {
  // Every character space-separated, as one model returned it.
  expect(texts("น ี ้ ใ ช ้ Railway")).toEqual(texts("นี้ใช้ Railway"));
  const [first] = tokenize("น ี ้");
  expect(first).toEqual({ text: "นี้", start: 0, end: 5 });
  // Between Thai and Latin, the space still separates.
  expect(texts("ใช้ Railway ไป")).toEqual(["ใ", "ช้", "railway", "ไ", "ป"]);
});

test("alternatives expand to every combination", () => {
  expect(expandAlternatives("{a|b} x {c|d}")).toEqual(["a x c", "a x d", "b x c", "b x d"]);
  expect(expandAlternatives("no groups")).toEqual(["no groups"]);
});

test("an exact transcript scores zero errors", () => {
  const result = score("ใช้ TypeScript", "ใช้ TypeScript");
  expect(result.errors).toBe(0);
  expect(result.errorRate).toBe(0);
  expect(result.segments.every((s) => s.kind !== "token" || s.status === "correct")).toBe(true);
});

test("any accepted alternative is correct, and the best match is reported", () => {
  const reference = "{โปรเจกต์|project}นี้";
  expect(score(reference, "project นี้").errors).toBe(0);
  expect(score(reference, "โปรเจกต์นี้").errors).toBe(0);
  expect(score(reference, "project นี้").matchedReference).toBe("projectนี้");
});

test("a wrong English word costs one token, a wrong Thai letter costs one token", () => {
  const reference = "ชื่อ Elysia";
  // 2 Thai tokens (`ชื่` is one cluster, then `อ`) + 1 Latin word = 3 tokens.
  expect(score(reference, "ชื่อ Alecia")).toMatchObject({ errors: 1, referenceTokens: 3 });
  expect(score(reference, "ชือ Elysia")).toMatchObject({ errors: 1, referenceTokens: 3 });
});

test("segments mark substitutions, insertions and deletions, and keep the original text", () => {
  const result = score("ไป Railway", "ไปที่ Railways!");
  expect(result.segments).toEqual([
    { kind: "token", text: "ไ", status: "correct" },
    { kind: "token", text: "ป", status: "correct" },
    { kind: "token", text: "ที่", status: "inserted" },
    { kind: "separator", text: " " },
    { kind: "token", text: "Railways", status: "substituted" },
    { kind: "separator", text: "!" },
  ]);
  expect(score("ไปที่", "ไป").segments).toContainEqual({ kind: "deleted", text: "ที่" });
});

test("the error rate can go above 1 when the transcript is mostly insertions", () => {
  const result = score("ไป", "a b c d");
  expect(result.errorRate).toBeGreaterThan(1);
});
