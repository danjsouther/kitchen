/**
 * Password-reset tokens: a random one-time credential handed out over email
 * and redeemed once. Only the SHA-256 hash of the token is ever persisted —
 * the raw token exists only in the email and the HTTP request that redeems
 * it, same principle as a password.
 *
 * No timingSafeEqual is needed to look one up: it is a lookup key (a unique
 * column), not a value compared byte-by-byte, same as passwordHash isn't
 * compared that way either.
 */

import { createHash, randomBytes } from 'node:crypto';

/** How long a reset link stays valid after being issued. */
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Generates a fresh token plus the hash to store for it. */
export function generateResetToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hash(token) };
}

/** Hashes an incoming token so it can be looked up by its stored hash. */
export function hashResetToken(token: string): string {
  return hash(token);
}
