// TOTP (RFC 6238) on top of HOTP (RFC 4226): HMAC-SHA1, 30 s step, 6 digits —
// the profile every authenticator app (Google Authenticator, Aegis, 1Password…) supports.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const STEP_SEC = 30;
export const stepAt = (unixMs: number) => Math.floor(unixMs / 1000 / STEP_SEC);

/**
 * Returns the matched time step (for replay protection) or null. Accepts the
 * neighbouring steps (±1) to tolerate clock drift.
 */
export function verifyTotp(secretB32: string, code: string, unixMs = Date.now(), window = 1): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretB32);
  const now = stepAt(unixMs);
  for (let d = -window; d <= window; d++) {
    const expected = Buffer.from(hotp(secret, now + d));
    if (timingSafeEqual(expected, Buffer.from(code))) return now + d;
  }
  return null;
}

export const newTotpSecret = () => base32Encode(randomBytes(20)); // 160 bits, as RFC 4226 recommends

export function otpauthUrl(secretB32: string, account: string, issuer = 'StreamHub'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: secretB32, issuer, algorithm: 'SHA1', digits: '6', period: String(STEP_SEC) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// Recovery codes: 8 × "xxxx-xxxx" (40 bits each), stored as SHA-256.
const RC_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export function newRecoveryCodes(n = 8): string[] {
  return Array.from({ length: n }, () => {
    const b = randomBytes(8);
    const chars = [...b].map((x) => RC_ALPHABET[x % RC_ALPHABET.length]).join('');
    return `${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
  });
}
export const normalizeRecoveryCode = (c: string) => c.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
export const hashRecoveryCode = (c: string) => createHash('sha256').update(normalizeRecoveryCode(c)).digest('hex');
