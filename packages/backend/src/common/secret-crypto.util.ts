/**
 * AES-256-GCM encryption for secrets we hold on a household's behalf — currently
 * their Anthropic API key, and nothing else.
 *
 * GCM is authenticated encryption: decryption verifies the auth tag and throws if
 * the ciphertext, IV, tag or key has been altered. That matters here because a
 * silently-corrupted key would surface as a confusing 401 from a third party
 * rather than as the storage problem it actually is.
 *
 * The master key comes from AI_ENCRYPTION_KEY (32 random bytes, base64). Rotating
 * it renders every stored household key undecryptable — by design, since there is
 * no way to re-encrypt what we cannot read. Each household then re-enters its own.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
/** AES-256 needs a 32-byte key. */
const KEY_BYTES = 32;
/** 96 bits is the GCM-recommended IV size, and what Node's GCM is optimised for. */
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export interface EncryptedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

/**
 * Decodes and validates the base64 master key.
 *
 * Throws rather than falling back to a derived or padded key: running with a
 * malformed encryption key would "work" until the moment secrets needed reading
 * back, which is the worst possible time to discover it.
 */
export function parseMasterKey(base64Key: string | undefined): Buffer {
  if (!base64Key) {
    throw new Error(
      'AI_ENCRYPTION_KEY is not set. Generate one with: ' +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }

  let key: Buffer;
  try {
    key = Buffer.from(base64Key, 'base64');
  } catch {
    throw new Error('AI_ENCRYPTION_KEY is not valid base64.');
  }

  if (key.length !== KEY_BYTES) {
    throw new Error(
      `AI_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes, got ${key.length}. ` +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }

  return key;
}

/**
 * Encrypts a secret. A fresh random IV is generated per call, so encrypting the
 * same value twice produces different ciphertext — never reuse an IV with GCM.
 */
export function encryptSecret(plaintext: string, key: Buffer): EncryptedSecret {
  if (key.length !== KEY_BYTES) {
    throw new Error(`Encryption key must be ${KEY_BYTES} bytes, got ${key.length}.`);
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

/**
 * Decrypts a secret, throwing if authentication fails.
 *
 * A failure here means the stored bytes do not match the key in use — usually a
 * rotated AI_ENCRYPTION_KEY, occasionally tampering. Either way the caller should
 * ask the household to re-enter its key rather than retrying.
 */
export function decryptSecret(secret: EncryptedSecret, key: Buffer): string {
  if (key.length !== KEY_BYTES) {
    throw new Error(`Encryption key must be ${KEY_BYTES} bytes, got ${key.length}.`);
  }
  if (secret.iv.length !== IV_BYTES) {
    throw new Error(`IV must be ${IV_BYTES} bytes, got ${secret.iv.length}.`);
  }
  if (secret.authTag.length !== AUTH_TAG_BYTES) {
    throw new Error(
      `Auth tag must be ${AUTH_TAG_BYTES} bytes, got ${secret.authTag.length}.`,
    );
  }

  const decipher = createDecipheriv(ALGORITHM, key, secret.iv);
  decipher.setAuthTag(secret.authTag);

  try {
    return Buffer.concat([
      decipher.update(secret.ciphertext),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // Node's message here ("Unsupported state or unable to authenticate data")
    // tells the operator nothing useful, so replace it with the likely cause.
    throw new Error(
      'Could not decrypt the stored secret. The AI_ENCRYPTION_KEY may have changed ' +
        'since it was saved; the household will need to re-enter its API key.',
    );
  }
}

/**
 * The last four characters of a secret, for display. This is the only part of a
 * stored key that may ever leave the server.
 */
export function lastFour(secret: string): string {
  return secret.slice(-4);
}

/**
 * Constant-time comparison, for anywhere a secret is checked against a candidate.
 * Avoids leaking how much of a value matched through response timing.
 */
export function secretsMatch(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
