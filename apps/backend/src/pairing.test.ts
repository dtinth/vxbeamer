import { expect, test } from "vite-plus/test";
import {
  createPairingStore,
  createRateLimiter,
  normalizePairingCode,
  PAIRING_CODE_LENGTH,
} from "./pairing.ts";

test("a minted code redeems once, for the identity it was minted for", () => {
  const store = createPairingStore();
  const { code, expiresIn } = store.mint({ sub: "user-1", name: "Ada" });
  expect(code).toHaveLength(PAIRING_CODE_LENGTH);
  expect(expiresIn).toBe(120);

  expect(store.redeem(code)).toEqual({ sub: "user-1", name: "Ada" });
  expect(store.redeem(code)).toBeNull();
});

test("a code expires after its lifetime", () => {
  let now = 1_000;
  const store = createPairingStore({ now: () => now, ttlMs: 60_000 });
  const { code } = store.mint({ sub: "user-1" });

  now += 60_000;
  expect(store.redeem(code)).toBeNull();
});

test("an expired code stays spent", () => {
  let now = 0;
  const store = createPairingStore({ now: () => now, ttlMs: 10 });
  const { code } = store.mint({ sub: "user-1" });
  now = 11;
  expect(store.redeem(code)).toBeNull();
  now = 0;
  expect(store.redeem(code)).toBeNull();
});

test("redeeming accepts the code as typed or pasted", () => {
  const store = createPairingStore();
  const { code } = store.mint({ sub: "user-1" });
  const typed = `${code.slice(0, 4)}-${code.slice(4, 8).toLowerCase()} ${code.slice(8)}`;
  expect(store.redeem(typed)).toEqual({ sub: "user-1" });
});

test("anything that is not a well-formed code is refused", () => {
  const store = createPairingStore();
  expect(store.redeem("")).toBeNull();
  expect(store.redeem("short")).toBeNull();
  expect(store.redeem("I".repeat(PAIRING_CODE_LENGTH))).toBeNull();
  const zeros = "0".repeat(PAIRING_CODE_LENGTH);
  expect(normalizePairingCode(zeros)).toBe(zeros);
});

test("two codes never collide, even when the random source repeats", () => {
  const sources = [new Uint8Array(12), new Uint8Array(12), new Uint8Array(12).fill(1)];
  const store = createPairingStore({
    randomBytes: () => sources.shift() ?? new Uint8Array(12).fill(2),
  });
  const first = store.mint({ sub: "a" });
  const second = store.mint({ sub: "b" });
  expect(second.code).not.toBe(first.code);
  expect(store.redeem(first.code)?.sub).toBe("a");
  expect(store.redeem(second.code)?.sub).toBe("b");
});

test("the rate limiter allows a burst, then refuses until the window passes", () => {
  let now = 0;
  const limiter = createRateLimiter({ max: 3, windowMs: 1_000, now: () => now });
  expect([1, 2, 3].map(() => limiter.allow("ip"))).toEqual([true, true, true]);
  expect(limiter.allow("ip")).toBe(false);
  expect(limiter.allow("other")).toBe(true);

  now = 1_000;
  expect(limiter.allow("ip")).toBe(true);
});
