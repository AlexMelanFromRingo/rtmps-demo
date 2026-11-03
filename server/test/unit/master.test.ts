import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMasterPlaylist, parseMediaPlaylist } from '../../src/worker/master.ts';
import { planLadder } from '../../src/worker/ladder.ts';

test('master playlist lists start variant first with codecs, audio group and NAME', () => {
  const plan = planLadder({ videoCodec: 'AV1', width: 1920, height: 1080, fps: 60, profile: 'Main', level: 9, hasAudio: true }, 'abr');
  const text = buildMasterPlaylist(plan, { source: 7000 });
  const lines = text.trim().split('\n');
  assert.equal(lines[0], '#EXTM3U');
  assert.match(text, /#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud".*URI="audio\/index\.m3u8"/);
  const firstInf = lines.find((l) => l.startsWith('#EXT-X-STREAM-INF'))!;
  assert.match(firstInf, /NAME="720p60"/);
  assert.match(firstInf, /CODECS="avc1\.640020,mp4a\.40\.2"/);
  assert.match(text, /CODECS="av01\.0\.09M\.08,mp4a\.40\.2".*NAME="source"\nsource\/index\.m3u8/);
  // observed source bitrate drives BANDWIDTH: (7000*1.3 + 160) * 1000 * 1.05
  assert.match(text, new RegExp(`BANDWIDTH=${Math.round((7000 * 1.3 + 160) * 1000 * 1.05)},`));
});

test('master without audio has no audio group', () => {
  const plan = planLadder({ videoCodec: 'H264', width: 1280, height: 720, fps: 30, hasAudio: false }, 'passthrough');
  const text = buildMasterPlaylist(plan);
  assert.doesNotMatch(text, /EXT-X-MEDIA|AUDIO=|mp4a/);
});

test('parseMediaPlaylist extracts segments and sequence', () => {
  const pl = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1793719345\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2.000000,\n#EXT-X-PROGRAM-DATE-TIME:2026-11-03T15:22:25.347+0000\nseg_1793719345.m4s\n#EXTINF:1.5,\nseg_1793719346.m4s\n';
  const parsed = parseMediaPlaylist(pl);
  assert.equal(parsed.mediaSequence, 1793719345);
  assert.deepEqual(parsed.segments, [{ uri: 'seg_1793719345.m4s', duration: 2 }, { uri: 'seg_1793719346.m4s', duration: 1.5 }]);
});
