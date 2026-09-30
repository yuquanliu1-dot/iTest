import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALG = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

let cachedKey: Buffer | null = null;

export function ensureKeyLoaded(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('ENCRYPTION_KEY is not set (base64-encoded 32 bytes required for AES-256-GCM)');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(`ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}`);
  }
  cachedKey = key;
  return key;
}

export function encrypt(plaintext: string): { ciphertext: Buffer; iv: Buffer; tag: Buffer } {
  const key = ensureKeyLoaded();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALG, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext, iv, tag };
}

export function decrypt(parts: { ciphertext: Buffer; iv: Buffer; tag: Buffer }): string {
  const key = ensureKeyLoaded();
  const decipher = createDecipheriv(ALG, key, parts.iv);
  decipher.setAuthTag(parts.tag);
  try {
    const out = Buffer.concat([decipher.update(parts.ciphertext), decipher.final()]);
    return out.toString('utf8');
  } catch (e) {
    throw new Error(`decrypt failed: ${(e as Error).message}`);
  }
}