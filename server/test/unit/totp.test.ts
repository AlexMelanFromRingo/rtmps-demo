import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  base32Decode, base32Encode, hashRecoveryCode, hotp, newRecoveryCodes, newTotpSecret, otpauthUrl, verifyTotp,
} from '../../src/lib/totp.ts';
import { open, seal } from '../../src/lib/secretbox.ts';

// RFC 6238 Appendix B (SHA-1 seed "12345678901234567890"), truncated to 6 digits.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));
const vectors: [number, string][] = [
  [59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
  [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130'],
];

test('HOTP/TOTP match the RFC 6238 test vectors', () => {
  for (const [t, code8] of vectors) {
    assert.equal(hotp(Buffer.from('12345678901234567890'), Math.floor(t / 30), 8), code8, `T=${t}`);
    assert.equal(verifyTotp(RFC_SECRET, code8.slice(-6), t * 1000, 0), Math.floor(t / 30));
  }
});

test('TOTP accepts ±1 step of drift, rejects others and malformed codes', () => {
  const secret = newTotpSecret();
  const now = Date.UTC(2026, 10, 3, 12, 0, 0);
  const step = Math.floor(now / 30_000);
  const at = (s: number) => hotp(base32Decode(secret), s);
  assert.equal(verifyTotp(secret, at(step - 1), now), step - 1);
  assert.equal(verifyTotp(secret, at(step + 1), now), step + 1);
  assert.equal(verifyTotp(secret, at(step + 2), now), null);
  assert.equal(verifyTotp(secret, '12345', now), null);
  assert.equal(verifyTotp(secret, 'abcdef', now), null);
});

test('base32 round-trips and otpauth URL is well formed', () => {
  const buf = Buffer.from('hello, authenticator');
  assert.deepEqual(base32Decode(base32Encode(buf)), buf);
  const url = new URL(otpauthUrl('JBSWY3DPEHPK3PXP', 'alice'));
  assert.equal(url.protocol, 'otpauth:');
  assert.equal(url.searchParams.get('issuer'), 'StreamHub');
  assert.equal(url.searchParams.get('digits'), '6');
});

test('recovery codes are unique, formatted and hashed case-insensitively', () => {
  const codes = newRecoveryCodes();
  assert.equal(new Set(codes).size, 8);
  for (const c of codes) assert.match(c, /^[a-z2-9]{4}-[a-z2-9]{4}$/);
  assert.equal(hashRecoveryCode(codes[0]!.toUpperCase()), hashRecoveryCode(codes[0]!.replace('-', ' ')));
});

test('secretbox: authenticated encryption, purpose-bound keys', () => {
  const sealed = seal('top secret', 'totp');
  assert.doesNotMatch(sealed, /top secret/);
  assert.equal(open(sealed, 'totp'), 'top secret');
  assert.throws(() => open(sealed, 'restream'), 'a different purpose derives a different key');
  // Flip one bit of the ciphertext → the GCM tag must reject it.
  const [v, iv, ct, tag] = sealed.split('.') as [string, string, string, string];
  const bytes = Buffer.from(ct, 'base64url');
  bytes[0] = bytes[0]! ^ 1;
  assert.throws(() => open([v, iv, bytes.toString('base64url'), tag].join('.'), 'totp'));
});
