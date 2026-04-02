import { expect, test } from "vite-plus/test";
import { createAccessToken, verifyAccessToken } from "./auth.ts";

test("verifyAccessToken validates signature and expiry", async () => {
  const token = await createAccessToken("user-1", "secret", 60);
  const payload = await verifyAccessToken(token, "secret");
  expect(payload?.sub).toBe("user-1");
  expect(payload?.sid).toBeTypeOf("string");
  expect(payload?.jti).toBeTypeOf("string");

  expect(token.split(".")).toHaveLength(3);

  const refreshedToken = await createAccessToken("user-1", "secret", 60, payload!.sid);
  const refreshedPayload = await verifyAccessToken(refreshedToken, "secret");
  expect(refreshedPayload?.sid).toBe(payload?.sid);
  expect(refreshedPayload?.jti).not.toBe(payload?.jti);

  const invalid = await verifyAccessToken(token, "another-secret");
  expect(invalid).toBeNull();
});
