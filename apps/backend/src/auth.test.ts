import { expect, test } from "vite-plus/test";
import {
  createAccessToken,
  createRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from "./auth.ts";

test("verifyAccessToken validates signature and expiry", async () => {
  const token = await createAccessToken({ subject: "user-1", secret: "secret", ttlSeconds: 60 });
  const payload = await verifyAccessToken(token, "secret");
  expect(payload?.sub).toBe("user-1");
  expect(payload?.sid).toBeTypeOf("string");
  expect(payload?.jti).toBeTypeOf("string");

  expect(token.split(".")).toHaveLength(3);

  const refreshedToken = await createAccessToken({
    subject: "user-1",
    secret: "secret",
    ttlSeconds: 60,
    sid: payload!.sid,
  });
  const refreshedPayload = await verifyAccessToken(refreshedToken, "secret");
  expect(refreshedPayload?.sid).toBe(payload?.sid);
  expect(refreshedPayload?.jti).not.toBe(payload?.jti);

  const invalid = await verifyAccessToken(token, "another-secret");
  expect(invalid).toBeNull();
});

test("verifyRefreshToken validates signature and token_type", async () => {
  const token = await createRefreshToken({ subject: "user-1", secret: "secret", ttlSeconds: 60 });
  const payload = await verifyRefreshToken(token, "secret");
  expect(payload?.sub).toBe("user-1");
  expect(payload?.token_type).toBe("refresh");
  expect(payload?.sid).toBeTypeOf("string");

  const accessToken = await createAccessToken({
    subject: "user-1",
    secret: "secret",
    ttlSeconds: 60,
  });
  const accessPayload = await verifyRefreshToken(accessToken, "secret");
  expect(accessPayload).toBeNull();
});
