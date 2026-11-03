import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cappedFps, parseRungs, planLadder, sourceUpgraded, type ProbedSource } from '../../src/worker/ladder.ts';

const src = (over: Partial<ProbedSource>): ProbedSource => ({
  videoCodec: 'H264', width: 1920, height: 1080, fps: 30, profile: 'High', level: 40, pixFmt: 'yuv420p', hasAudio: true, ...over,
});
const names = (p: ReturnType<typeof planLadder>) => p.variants.map((v) => v.name);

test('1080p30 H.264 in abr mode: source + lower rungs, no duplicate 1080p encode', () => {
  const plan = planLadder(src({}), 'abr');
  assert.deepEqual(new Set(names(plan)), new Set(['source', '720p', '480p', '360p', '160p']));
  assert.equal(plan.variants[0]!.name, '720p', 'start variant is the H.264 rendition closest to 720p');
  const source = plan.variants.find((v) => v.name === 'source')!;
  assert.equal(source.kind, 'copy');
  assert.equal(source.codecString, 'avc1.640028');
  assert.ok(plan.audio);
  assert.equal(plan.decodeKeyframesOnly, false);
});

test('1080p60 AV1 source gets an H.264 1080p60 rendition for compatibility', () => {
  const plan = planLadder(src({ videoCodec: 'AV1', profile: 'Main', level: 9, fps: 60 }), 'abr');
  const byName = Object.fromEntries(plan.variants.map((v) => [v.name, v]));
  assert.ok(byName.source && byName.source.codec === 'AV1' && byName.source.kind === 'copy');
  assert.equal(byName.source.codecString, 'av01.0.09M.08');
  assert.ok(byName['1080p60'] && byName['1080p60'].codec === 'H264');
  assert.ok(byName['720p60'], '720p keeps 60 fps');
  assert.ok(byName['480p'] && byName['480p'].fps === 30, '480p is capped to 30 fps');
  assert.equal(byName['1080p60'].bitrateKbps, 6000);
});

test('VP8 (not passthrough-able) is fully transcoded', () => {
  const plan = planLadder(src({ videoCodec: 'VP8', width: 1280, height: 720 }), 'abr');
  assert.ok(!names(plan).includes('source'));
  assert.deepEqual(new Set(names(plan)), new Set(['720p', '480p', '360p', '160p']));
});

test('passthrough mode only offers the source', () => {
  const plan = planLadder(src({ videoCodec: 'H265', profile: 'Main', level: 123 }), 'passthrough');
  assert.deepEqual(names(plan), ['source']);
  assert.equal(plan.variants[0]!.codecString, 'hvc1.1.6.L123.B0');
  assert.equal(plan.decodeKeyframesOnly, true);
});

test('passthrough mode with VP9 falls back to one H.264 copy at source resolution', () => {
  const plan = planLadder(src({ videoCodec: 'VP9', width: 1280, height: 720 }), 'passthrough');
  assert.deepEqual(names(plan), ['720p']);
  assert.equal(plan.variants[0]!.kind, 'encode');
});

test('never upscales; low-res sources get only lower rungs', () => {
  const plan = planLadder(src({ width: 640, height: 360 }), 'abr');
  assert.deepEqual(new Set(names(plan)), new Set(['source', '160p']));
});

test('4K sources are encoded at most at 1080p', () => {
  const plan = planLadder(src({ videoCodec: 'H265', width: 3840, height: 2160, level: 153 }), 'abr');
  const encodes = plan.variants.filter((v) => v.kind === 'encode');
  assert.equal(Math.max(...encodes.map((v) => v.height)), 1080);
});

test('vertical video uses the short side for rung names', () => {
  const plan = planLadder(src({ videoCodec: 'VP9', width: 1080, height: 1920 }), 'abr');
  const top = plan.variants.find((v) => v.name === '1080p')!;
  assert.equal(top.width, 1080);
  assert.equal(top.height, 1920);
  const r720 = plan.variants.find((v) => v.name === '720p')!;
  assert.equal(r720.width, 720);
  assert.equal(r720.height, 1280);
});

test('odd source resolution (900p VP9) gets an even-sized top rendition with scaled bitrate', () => {
  const plan = planLadder(src({ videoCodec: 'VP9', width: 1600, height: 900 }), 'abr');
  const top = plan.variants.find((v) => v.name === '900p')!;
  assert.equal(top.width % 2, 0);
  assert.ok(top.bitrateKbps > 2500 && top.bitrateKbps < 4500);
});

test('no audio track → no audio rendition', () => {
  assert.equal(planLadder(src({ hasAudio: false }), 'abr').audio, null);
});

test('cappedFps keeps cadence', () => {
  assert.equal(cappedFps(59.94, 30), 29.97);
  assert.equal(cappedFps(60, 60), 60);
  assert.equal(cappedFps(50, 30), 25);
  assert.equal(cappedFps(0, 30), 30);
  assert.equal(cappedFps(144, 60), 48);
});

test('parseRungs filters the default ladder', () => {
  assert.deepEqual(parseRungs('720, 360').map((r) => r.short), [720, 360]);
  assert.equal(parseRungs('').length, 5);
  assert.equal(parseRungs('999').length, 5);
});

test('rejects sources without dimensions', () => {
  assert.throws(() => planLadder(src({ width: 0 }), 'abr'));
});

test('degraded mode: source only, plus one ≤480p H.264 rendition for non-H.264 sources', () => {
  assert.deepEqual(names(planLadder(src({}), 'degraded')), ['source']);
  assert.deepEqual(new Set(names(planLadder(src({ videoCodec: 'AV1', profile: 'Main' }), 'degraded'))), new Set(['source', '480p']));
  assert.deepEqual(names(planLadder(src({ videoCodec: 'VP8' }), 'degraded')), ['480p']);
  assert.deepEqual(names(planLadder(src({ videoCodec: 'VP8', width: 640, height: 360 }), 'degraded')), ['360p']);
});

test('sourceUpgraded: re-plan on resolution growth or codec switch, not on shrink', () => {
  const p360 = src({ videoCodec: 'VP9', width: 640, height: 360 });
  assert.equal(sourceUpgraded(p360, src({ videoCodec: 'VP9', width: 1280, height: 720 })), true, 'WebRTC ramp-up');
  assert.equal(sourceUpgraded(p360, src({ videoCodec: 'VP9', width: 640, height: 360 })), false);
  assert.equal(sourceUpgraded(src({}), src({ width: 1280, height: 720 })), false, 'shrink keeps the ladder');
  assert.equal(sourceUpgraded(src({}), src({ videoCodec: 'H265' })), true, 'codec switch');
  assert.equal(sourceUpgraded(src({ hasAudio: false }), src({})), true, 'audio appeared');
});
