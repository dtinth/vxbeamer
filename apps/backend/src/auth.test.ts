import { expect, test } from "vite-plus/test";
import { createAccessToken, createPkceChallenge, verifyAccessToken, verifyPkce } from "./auth.ts";

test("verifyPkce validates code challenge", () => {
  const verifier = "sample-code-verifier";
  const challenge = createPkceChallenge(verifier);
  expect(verifyPkce(verifier, challenge)).toBe(true);
  expect(verifyPkce("wrong", challenge)).toBe(false);
});

test("verifyAccessToken validates signature and expiry", () => {
  const token = createAccessToken("user-1", "secret", 60);
  const payload = verifyAccessToken(token, "secret");
  expect(payload?.sub).toBe("user-1");

  const invalid = verifyAccessToken(token, "another-secret");
  expect(invalid).toBeNull();
});
