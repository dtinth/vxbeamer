import { createHmac, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";

export function base64UrlEncode(input: Uint8Array): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

interface AccessTokenPayload {
  sub: string;
  exp: number;
}

const DEFAULT_TOKEN_TTL_SECONDS = 600;

function sign(payload: string, secret: string): string {
  return base64UrlEncode(createHmac("sha256", secret).update(payload).digest());
}

function decodeBase64Url(input: string): string {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

export function createAccessToken(
  subject: string,
  secret: string,
  ttlSeconds = DEFAULT_TOKEN_TTL_SECONDS,
): string {
  const payload: AccessTokenPayload = {
    sub: subject,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const payloadRaw = JSON.stringify(payload);
  const encodedPayload = base64UrlEncode(Buffer.from(payloadRaw, "utf8"));
  const signature = sign(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

export function verifyAccessToken(token: string, secret: string): AccessTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) {
    return null;
  }
  const [encodedPayload, encodedSignature] = parts;
  if (!encodedPayload || !encodedSignature) {
    return null;
  }

  const expected = sign(encodedPayload, secret);
  const expectedBuffer = Buffer.from(expected, "utf8");
  const providedBuffer = Buffer.from(encodedSignature, "utf8");
  if (expectedBuffer.length !== providedBuffer.length) {
    return null;
  }
  if (!timingSafeEqual(expectedBuffer, providedBuffer)) {
    return null;
  }

  const payload = JSON.parse(decodeBase64Url(encodedPayload)) as AccessTokenPayload;
  if (payload.exp <= Math.floor(Date.now() / 1000)) {
    return null;
  }
  return payload;
}

const jwksSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwkSet(jwksUri: string): ReturnType<typeof createRemoteJWKSet> {
  let set = jwksSets.get(jwksUri);
  if (!set) {
    set = createRemoteJWKSet(new URL(jwksUri));
    jwksSets.set(jwksUri, set);
  }
  return set;
}

export async function verifyIdToken(
  token: string,
  issuer: string,
  jwksUri: string,
  audience: string,
): Promise<{ sub: string }> {
  const { payload } = await jwtVerify(token, getJwkSet(jwksUri), { issuer, audience });
  if (!payload.sub) {
    throw new Error("Missing sub claim");
  }
  return { sub: payload.sub };
}
