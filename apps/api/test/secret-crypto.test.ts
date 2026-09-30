import { describe, it, expect, beforeAll } from 'vitest';
import { encrypt, decrypt, ensureKeyLoaded } from '../src/lib/secret-crypto.js';

beforeAll(() => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  ensureKeyLoaded();
});

describe('secret-crypto', () => {
  it('roundtrips plaintext', () => {
    const { ciphertext, iv, tag } = encrypt('hunter2');
    expect(decrypt({ ciphertext, iv, tag })).toBe('hunter2');
  });

  it('different ivs produce different ciphertexts for same plaintext', () => {
    const a = encrypt('same');
    const b = encrypt('same');
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.iv.equals(b.iv)).toBe(false);
  });

  it('tampered tag fails decryption', () => {
    const { ciphertext, iv, tag } = encrypt('secret');
    const tampered = Buffer.from(tag);
    tampered[0] = tampered[0]! ^ 1;
    expect(() => decrypt({ ciphertext, iv, tag: tampered })).toThrow(/decrypt/);
  });
});