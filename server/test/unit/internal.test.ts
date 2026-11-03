import { test } from 'node:test';
import assert from 'node:assert/strict';
import { internalSecretFrom } from '../../src/lib/internalAuth.ts';

test('internal secret is read from Bearer or Basic Authorization, never elsewhere', () => {
  assert.equal(internalSecretFrom('Bearer s3cr3t'), 's3cr3t');
  assert.equal(internalSecretFrom(`Basic ${Buffer.from('mediamtx:s3cr3t').toString('base64')}`), 's3cr3t');
  assert.equal(internalSecretFrom(undefined), '');
  assert.equal(internalSecretFrom('Token s3cr3t'), '');
});
