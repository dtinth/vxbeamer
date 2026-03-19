import { beforeEach, expect, test, vi } from "vite-plus/test";
import { createCodeChallenge, createCodeVerifier, toWebSocketUrl } from "./oidc";

beforeEach(() => {
  vi.unstubAllGlobals();
});

test("toWebSocketUrl converts to ws endpoint", () => {
  expect(toWebSocketUrl("http://localhost:8787")).toBe("ws://localhost:8787/ws");
  expect(toWebSocketUrl("https://example.com/api")).toBe("wss://example.com/ws");
});

test("createCodeVerifier returns URL-safe token", () => {
  const verifier = createCodeVerifier();
  expect(verifier.length).toBeGreaterThan(30);
  expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
});

test("createCodeChallenge produces deterministic digest", async () => {
  const challenge = await createCodeChallenge("sample-verifier");
  expect(challenge).toBe("abasUUqDJc2OV5lZNoM-7GwF4WqxlIUb0UAD7LsCqHY");
});
