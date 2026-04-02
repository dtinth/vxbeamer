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
  iat: number;
  exp: number;
}

const DEFAULT_TOKEN_TTL_SECONDS = 600;

export async function createAccessToken(
  subject: string,
  secret: string,
  ttlSeconds = DEFAULT_TOKEN_TTL_SECONDS,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(subject)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(textEncoder.encode(secret));
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
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number"
    ) {
      return null;
    }
    if (payload.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    return {
      sub: payload.sub,
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
): Promise<{ sub: string }> {
  const { payload } = await jwtVerify(token, getJwkSet(jwksUri), { issuer, audience });
  if (!payload.sub) {
    throw new Error("Missing sub claim");
  }
  return { sub: payload.sub };
}
