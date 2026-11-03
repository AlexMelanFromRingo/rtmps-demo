import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateAddress, validateDestinationUrl } from '../../src/lib/egress.ts';

test('private, loopback, link-local and CGNAT addresses are blocked', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('destination URLs: public RTMP/RTMPS/SRT only, no credentials, no internal hosts', () => {
  assert.equal(validateDestinationUrl('rtmp://live.twitch.tv/app'), null);
  assert.equal(validateDestinationUrl('rtmps://fa723fc1b171.global-contribute.live-video.net/app'), null);
  assert.equal(validateDestinationUrl('srt://ingest.example.com:9000'), null);
  assert.match(validateDestinationUrl('http://example.com/x')!, /rtmp/);
  assert.match(validateDestinationUrl('rtmp://user:pass@example.com/app')!, /Ключ/);
  assert.match(validateDestinationUrl('rtmp://api:3000/x')!, /внутренней/);
  assert.match(validateDestinationUrl('rtmp://127.0.0.1/app')!, /внутренней/);
  assert.match(validateDestinationUrl('rtmp://169.254.169.254/latest')!, /внутренней/);
  assert.match(validateDestinationUrl('rtmp://box.local/app')!, /внутренней/);
});
