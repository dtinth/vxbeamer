import { randomUUID } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, SignJWT } from "jose";

const textEncoder = new TextEncoder();

export function base64UrlEncode(input: Uint8Array): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export interface AccessTokenPayload {
  sub: string;
  name?: string;
  sid: string;
  token_type: "access" | "refresh";
  jti: string;
  iat: number;
  exp: number;
}

const DEFAULT_TOKEN_TTL_SECONDS = 600;

export async function createAccessToken(options: {
  subject: string;
  secret: string;
  ttlSeconds?: number;
  sid?: string;
  name?: string;
}): Promise<string> {
  const {
    subject,
    secret,
    ttlSeconds = DEFAULT_TOKEN_TTL_SECONDS,
    sid = randomUUID(),
    name,
  } = options;
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({ sid, token_type: "access", ...(name ? { name } : {}) })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setJti(randomUUID())
    .setSubject(subject)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(textEncoder.encode(secret));
}

export async function createRefreshToken(options: {
  subject: string;
  secret: string;
  ttlSeconds?: number;
  sid?: string;
}): Promise<string> {
  const { subject, secret, ttlSeconds = 259200, sid = randomUUID() } = options;
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({ sid, token_type: "refresh" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setJti(randomUUID())
    .setSubject(subject)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(textEncoder.encode(secret));
}

export interface RefreshTokenPayload {
  sub: string;
  sid: string;
  token_type: "refresh";
  jti: string;
  iat: number;
  exp: number;
}

export async function verifyRefreshToken(
  token: string,
  secret: string,
): Promise<RefreshTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, textEncoder.encode(secret), {
      algorithms: ["HS256"],
      typ: "JWT",
    });
    if (
      typeof payload.sub !== "string" ||
      typeof payload.sid !== "string" ||
      typeof payload.jti !== "string" ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number" ||
      payload.token_type !== "refresh"
    ) {
      return null;
    }
    if (payload.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    return {
      sub: payload.sub,
      sid: payload.sid,
      token_type: "refresh",
      jti: payload.jti,
      iat: payload.iat,
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}

export async function verifyAccessToken(
  token: string,
  secret: string,
): Promise<AccessTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, textEncoder.encode(secret), {
      algorithms: ["HS256"],
      typ: "JWT",
    });
    if (
      typeof payload.sub !== "string" ||
      typeof payload.sid !== "string" ||
      typeof payload.jti !== "string" ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number" ||
      payload.token_type !== "access"
    ) {
      return null;
    }
    if (payload.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    const name = typeof payload.name === "string" ? payload.name : undefined;
    return {
      sub: payload.sub,
      name,
      sid: payload.sid,
      token_type: "access",
      jti: payload.jti,
      iat: payload.iat,
      exp: payload.exp,
    };
  } catch {
    return null;
  }
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
): Promise<{ sub: string; name?: string }> {
  const { payload } = await jwtVerify(token, getJwkSet(jwksUri), { issuer, audience });
  if (!payload.sub) {
    throw new Error("Missing sub claim");
  }
  const name = typeof payload.name === "string" ? payload.name : undefined;
  return { sub: payload.sub, name };
}
