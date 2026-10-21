import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

const VERSION = 'v1';

function key(): Buffer {
  return Buffer.from(config().ENCRYPTION_KEY, 'base64');
}

/** AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext> (base64url). */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), enc.toString('base64url')].join('.');
}

export function decrypt(payload: string): string {
  const [version, iv, tag, data] = payload.split('.');
  if (version !== VERSION || !iv || !tag || data === undefined) throw new Error('Unsupported ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

export function encryptNullable(value: string | null | undefined): string | null {
  return value ? encrypt(value) : null;
}

export function decryptNullable(value: string | null | undefined): string | null {
  return value ? decrypt(value) : null;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function mask(value: string | null): string | null {
  if (!value) return value;
  return value.length <= 4 ? '****' : `${'*'.repeat(Math.max(4, value.length - 4))}${value.slice(-4)}`;
}
