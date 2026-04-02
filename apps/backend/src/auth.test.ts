import { expect, test } from "vite-plus/test";
import { createAccessToken, verifyAccessToken } from "./auth.ts";

test("verifyAccessToken validates signature and expiry", async () => {
  const token = await createAccessToken("user-1", "secret", 60);
  const payload = await verifyAccessToken(token, "secret");
  expect(payload?.sub).toBe("user-1");

  expect(token.split(".")).toHaveLength(3);

  const invalid = await verifyAccessToken(token, "another-secret");
  expect(invalid).toBeNull();
});
