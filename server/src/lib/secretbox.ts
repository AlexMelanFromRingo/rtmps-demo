// Authenticated encryption for secrets stored in the database (TOTP seeds,
// third-party stream keys): AES-256-GCM with a key derived via HKDF from
// DATA_ENCRYPTION_KEY (or, if unset, INTERNAL_SECRET).
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { config } from '../config.ts';

const VERSION = 'v1';

function key(purpose: string): Buffer {
  const ikm = process.env.DATA_ENCRYPTION_KEY || config.internalSecret;
  return Buffer.from(hkdfSync('sha256', ikm, 'streamhub', `secretbox:${purpose}`, 32));
}

export function seal(plaintext: string, purpose: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(purpose), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), ct.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
}

export function open(sealed: string, purpose: string): string {
  const [v, iv, ct, tag] = sealed.split('.');
  if (v !== VERSION || !iv || ct === undefined || !tag) throw new Error('malformed secret');
  const decipher = createDecipheriv('aes-256-gcm', key(purpose), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}
