import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sleep } from '../../src/lib/shutdown.ts';
import { redact } from '../../src/lib/redact.ts';
import { config } from '../../src/config.ts';

test('redact removes credentials, the internal secret and stream keys', () => {
  const key = `live_${'A'.repeat(32)}`;
  const s = redact(`Error opening input rtsp://transcoder:${config.internalSecret}@ingest:8554/live/${key}: refused; `
    + `srt://ingest:8890?streamid=read:live/${key}:transcoder:${config.internalSecret}`);
  assert.doesNotMatch(s, new RegExp(config.internalSecret));
  assert.doesNotMatch(s, /A{32}/);
  assert.match(s, /rtsp:\/\/\*\*\*@ingest:8554\/live\/live_\*\*\*/);
});

test('sleep does not leak abort listeners', async () => {
  const ctl = new AbortController();
  let added = 0;
  let removed = 0;
  const add = ctl.signal.addEventListener.bind(ctl.signal);
  const rem = ctl.signal.removeEventListener.bind(ctl.signal);
  ctl.signal.addEventListener = ((...a: Parameters<typeof add>) => { added++; return add(...a); }) as typeof add;
  ctl.signal.removeEventListener = ((...a: Parameters<typeof rem>) => { removed++; return rem(...a); }) as typeof rem;
  for (let i = 0; i < 5; i++) await sleep(1, ctl.signal);
  assert.equal(added, 5);
  assert.equal(removed, 5);
});
