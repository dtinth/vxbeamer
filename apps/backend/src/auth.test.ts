import { expect, test } from "vite-plus/test";
import { createAccessToken, verifyAccessToken } from "./auth.ts";

test("verifyAccessToken validates signature and expiry", () => {
  const token = createAccessToken("user-1", "secret", 60);
  const payload = verifyAccessToken(token, "secret");
  expect(payload?.sub).toBe("user-1");

  const invalid = verifyAccessToken(token, "another-secret");
  expect(invalid).toBeNull();
});
