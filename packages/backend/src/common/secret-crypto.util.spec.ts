import { randomBytes } from 'node:crypto';

import {
  decryptSecret,
  encryptSecret,
  lastFour,
  parseMasterKey,
  secretsMatch,
} from './secret-crypto.util';

const key = randomBytes(32);
const otherKey = randomBytes(32);
const apiKey = 'sk-ant-api03-EXAMPLE-not-a-real-key-0123456789abcdef';

describe('parseMasterKey', () => {
  it('accepts a 32-byte base64 key', () => {
    const encoded = key.toString('base64');
    expect(parseMasterKey(encoded).equals(key)).toBe(true);
  });

  it('rejects a missing key with actionable guidance', () => {
    expect(() => parseMasterKey(undefined)).toThrow(/AI_ENCRYPTION_KEY is not set/);
    expect(() => parseMasterKey(undefined)).toThrow(/randomBytes\(32\)/);
  });

  it('rejects a key of the wrong length rather than padding it', () => {
    const short = randomBytes(16).toString('base64');
    expect(() => parseMasterKey(short)).toThrow(/exactly 32 bytes, got 16/);
  });

  it('rejects an empty string', () => {
    expect(() => parseMasterKey('')).toThrow(/not set/);
  });
});

describe('encryptSecret / decryptSecret', () => {
  it('round-trips a secret', () => {
    const encrypted = encryptSecret(apiKey, key);
    expect(decryptSecret(encrypted, key)).toBe(apiKey);
  });

  it('does not leave the plaintext visible in the ciphertext', () => {
    const encrypted = encryptSecret(apiKey, key);
    expect(encrypted.ciphertext.toString('utf8')).not.toContain('sk-ant');
    expect(encrypted.ciphertext.toString('base64')).not.toContain(apiKey);
  });

  it('produces different ciphertext each time (fresh IV per call)', () => {
    const first = encryptSecret(apiKey, key);
    const second = encryptSecret(apiKey, key);

    expect(first.iv.equals(second.iv)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
    // Both still decrypt to the same value.
    expect(decryptSecret(first, key)).toBe(decryptSecret(second, key));
  });

  it('round-trips unicode and empty values', () => {
    for (const value of ['', 'ключ-🔑-ключ', 'a'.repeat(5000)]) {
      expect(decryptSecret(encryptSecret(value, key), key)).toBe(value);
    }
  });

  // The whole point of GCM: corruption is detected, never silently decrypted.
  it('fails with the wrong key rather than returning garbage', () => {
    const encrypted = encryptSecret(apiKey, key);
    expect(() => decryptSecret(encrypted, otherKey)).toThrow(
      /Could not decrypt the stored secret/,
    );
  });

  it('explains that a rotated AI_ENCRYPTION_KEY is the likely cause', () => {
    const encrypted = encryptSecret(apiKey, key);
    expect(() => decryptSecret(encrypted, otherKey)).toThrow(/re-enter its API key/);
  });

  it('fails when the ciphertext is tampered with', () => {
    const encrypted = encryptSecret(apiKey, key);
    encrypted.ciphertext[0] ^= 0xff;
    expect(() => decryptSecret(encrypted, key)).toThrow(/Could not decrypt/);
  });

  it('fails when the auth tag is tampered with', () => {
    const encrypted = encryptSecret(apiKey, key);
    encrypted.authTag[0] ^= 0xff;
    expect(() => decryptSecret(encrypted, key)).toThrow(/Could not decrypt/);
  });

  it('fails when the IV is tampered with', () => {
    const encrypted = encryptSecret(apiKey, key);
    encrypted.iv[0] ^= 0xff;
    expect(() => decryptSecret(encrypted, key)).toThrow(/Could not decrypt/);
  });

  it.each([
    ['iv', 8],
    ['authTag', 8],
  ])('rejects a malformed %s length', (field, length) => {
    const encrypted = encryptSecret(apiKey, key);
    (encrypted as unknown as Record<string, Buffer>)[field] = randomBytes(length);
    expect(() => decryptSecret(encrypted, key)).toThrow(new RegExp(`${field === 'iv' ? 'IV' : 'Auth tag'} must be`));
  });

  it('rejects an encryption key of the wrong size', () => {
    expect(() => encryptSecret(apiKey, randomBytes(16))).toThrow(/must be 32 bytes/);
  });
});

describe('lastFour', () => {
  it('returns the final four characters', () => {
    expect(lastFour('sk-ant-api03-abcdef')).toBe('cdef');
  });

  it('does not blow up on short input', () => {
    expect(lastFour('ab')).toBe('ab');
  });
});

describe('secretsMatch', () => {
  it('is true for identical values', () => {
    expect(secretsMatch(apiKey, apiKey)).toBe(true);
  });

  it('is false for different values', () => {
    expect(secretsMatch(apiKey, `${apiKey}x`)).toBe(false);
    expect(secretsMatch('abcd', 'abce')).toBe(false);
  });
});
