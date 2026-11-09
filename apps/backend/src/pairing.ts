import { randomBytes } from "node:crypto";

/**
 * Pairing codes: a signed-in browser mints one, the user carries it to a
 * client (paste, scan, open the link), and the client redeems it for a session.
 *
 * Kept in memory on purpose. A code lives for two minutes and is single use, so
 * losing them on a restart costs one more tap. The backend stays otherwise
 * stateless; a deployment with several instances would need to share this (or
 * sign the codes instead, at the price of single use).
 */

// Crockford's base32: no I, L, O or U, so a code read aloud or copied by eye
// has fewer ways to go wrong.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 12 characters of 5 bits each: 60 bits, out of reach for a guess inside the lifetime. */
export const PAIRING_CODE_LENGTH = 12;

export const PAIRING_CODE_TTL_MS = 120_000;

export interface PairingIdentity {
  sub: string;
  name?: string;
}

interface PairingEntry extends PairingIdentity {
  expiresAt: number;
}

export interface PairingStore {
  mint(identity: PairingIdentity): { code: string; expiresIn: number };
  /** Spends the code. Anything but a live, unspent code is `null`. */
  redeem(code: string): PairingIdentity | null;
}

export function createPairingStore(
  options: { now?: () => number; ttlMs?: number; randomBytes?: (size: number) => Uint8Array } = {},
): PairingStore {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? PAIRING_CODE_TTL_MS;
  const random = options.randomBytes ?? randomBytes;
  const entries = new Map<string, PairingEntry>();

  function purgeExpired() {
    const t = now();
    for (const [code, entry] of entries) {
      if (entry.expiresAt <= t) entries.delete(code);
    }
  }

  function generate(): string {
    const bytes = random(PAIRING_CODE_LENGTH);
    let code = "";
    for (let i = 0; i < PAIRING_CODE_LENGTH; i++) code += ALPHABET[bytes[i]! % ALPHABET.length];
    return code;
  }

  return {
    mint(identity) {
      purgeExpired();
      let code = generate();
      while (entries.has(code)) code = generate();
      entries.set(code, { ...identity, expiresAt: now() + ttlMs });
      return { code, expiresIn: Math.floor(ttlMs / 1000) };
    },
    redeem(code) {
      const normalized = normalizePairingCode(code);
      if (!normalized) return null;
      const entry = entries.get(normalized);
      if (!entry) return null;
      // Spent whether or not it is still good: an expired code stays unusable.
      entries.delete(normalized);
      if (entry.expiresAt <= now()) return null;
      return { sub: entry.sub, ...(entry.name ? { name: entry.name } : {}) };
    },
  };
}

/** Accepts a code as typed or pasted: any case, with spaces or dashes in it. */
export function normalizePairingCode(input: string): string | null {
  const code = input.replace(/[\s-]/g, "").toUpperCase();
  if (code.length !== PAIRING_CODE_LENGTH) return null;
  for (const char of code) if (!ALPHABET.includes(char)) return null;
  return code;
}

export interface RateLimiter {
  /** Counts an attempt for `key`; false once it has used up its allowance. */
  allow(key: string): boolean;
}

/** A fixed window per key, in memory. Enough to make guessing a code pointless. */
export function createRateLimiter(options: {
  max: number;
  windowMs: number;
  now?: () => number;
}): RateLimiter {
  const now = options.now ?? Date.now;
  const windows = new Map<string, { start: number; count: number }>();
  return {
    allow(key) {
      const t = now();
      const current = windows.get(key);
      if (!current || t - current.start >= options.windowMs) {
        if (windows.size > 10_000) {
          for (const [k, w] of windows) if (t - w.start >= options.windowMs) windows.delete(k);
        }
        windows.set(key, { start: t, count: 1 });
        return true;
      }
      current.count += 1;
      return current.count <= options.max;
    },
  };
}
