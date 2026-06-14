'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  VARIANTS,
  getBitrate,
  getMaxBitrate,
  getBufferSize,
  globalVideoEncoderArgs,
  buildHLSArgs,
  probeEncoder,
  detectHardwareEncoder,
  resetEncoderCache,
} = require('../lib/encoding');

test('resolution helpers return known and default bitrates', () => {
  assert.equal(getBitrate('1920x1080'), '5000k');
  assert.equal(getMaxBitrate('1280x720'), '3000k');
  assert.equal(getBufferSize('854x480'), '2500k');
  // Unknown resolutions fall back to defaults.
  assert.equal(getBitrate('999x999'), '5000k');
  assert.equal(getMaxBitrate('999x999'), '6000k');
  assert.equal(getBufferSize('999x999'), '10000k');
});

test('globalVideoEncoderArgs selects the right codec', () => {
  assert.deepEqual(globalVideoEncoderArgs('h264_nvenc').slice(0, 2), ['-c:v', 'h264_nvenc']);
  assert.deepEqual(globalVideoEncoderArgs('h264_qsv').slice(0, 2), ['-c:v', 'h264_qsv']);
  assert.deepEqual(globalVideoEncoderArgs('libx264').slice(0, 2), ['-c:v', 'libx264']);
  // Unknown encoder falls back to libx264.
  assert.deepEqual(globalVideoEncoderArgs('nope').slice(0, 2), ['-c:v', 'libx264']);
});

test('buildHLSArgs produces a coherent ABR ladder', () => {
  const args = buildHLSArgs('rtmp://127.0.0.1:1935/live/abc', '/tmp/out', 'libx264');

  // Input present.
  const i = args.indexOf('-i');
  assert.ok(i >= 0);
  assert.equal(args[i + 1], 'rtmp://127.0.0.1:1935/live/abc');

  // One split into N renditions.
  const fc = args[args.indexOf('-filter_complex') + 1];
  assert.match(fc, new RegExp(`\\[0:v\\]split=${VARIANTS.length}`));
  VARIANTS.forEach((_, idx) => assert.match(fc, new RegExp(`\\[v${idx}out\\]`)));

  // Exactly N video maps + N audio maps.
  const videoMaps = args.filter((a, idx) => a === '-map' && args[idx + 1].startsWith('[v'));
  const audioMaps = args.filter((a, idx) => a === '-map' && args[idx + 1] === '0:a:0');
  assert.equal(videoMaps.length, VARIANTS.length);
  assert.equal(audioMaps.length, VARIANTS.length);

  // Per-rendition bitrate ceilings.
  VARIANTS.forEach((v, idx) => {
    assert.equal(args[args.indexOf(`-b:v:${idx}`) + 1], v.vBitrate);
    assert.equal(args[args.indexOf(`-maxrate:v:${idx}`) + 1], v.vMaxrate);
    assert.equal(args[args.indexOf(`-bufsize:v:${idx}`) + 1], v.vBufsize);
    assert.equal(args[args.indexOf(`-b:a:${idx}`) + 1], v.aBitrate);
  });

  // HLS muxing config: master playlist + named variant streams.
  assert.equal(args[args.indexOf('-f') + 1], 'hls');
  assert.equal(args[args.indexOf('-master_pl_name') + 1], 'master.m3u8');
  const vsm = args[args.indexOf('-var_stream_map') + 1];
  VARIANTS.forEach((v, idx) => assert.match(vsm, new RegExp(`v:${idx},a:${idx},name:${v.name}`)));

  // Output template uses %v so each rendition lands in its own subdir.
  assert.equal(args[args.length - 1], '/tmp/out/%v/index.m3u8');
  assert.equal(args[args.indexOf('-hls_segment_filename') + 1], '/tmp/out/%v/segment_%03d.ts');

  // No leftover stream-specifier corruption from the old .replace() hack.
  assert.ok(!args.some((a) => a === '-c:v:1' || a === '-profile:v:1' || a === '-profile:v:2'));
});

test('buildHLSArgs respects a custom variant list', () => {
  const variants = [{ name: '720p', width: 1280, height: 720, vBitrate: '2500k', vMaxrate: '3000k', vBufsize: '5000k', aBitrate: '128k' }];
  const args = buildHLSArgs('in', '/o', 'libx264', variants);
  const fc = args[args.indexOf('-filter_complex') + 1];
  assert.match(fc, /\[0:v\]split=1/);
  assert.equal(args[args.indexOf('-var_stream_map') + 1], 'v:0,a:0,name:720p');
});

test('probeEncoder reports libx264 as available (ffmpeg required)', async () => {
  // libx264 should always work where ffmpeg is built with it.
  const ok = await probeEncoder('libx264');
  assert.equal(ok, true);
});

test('probeEncoder rejects a bogus encoder', async () => {
  const ok = await probeEncoder('definitely_not_an_encoder');
  assert.equal(ok, false);
});

test('detectHardwareEncoder returns a usable encoder and caches it', async () => {
  resetEncoderCache();
  const enc = await detectHardwareEncoder();
  assert.ok(['h264_nvenc', 'h264_qsv', 'libx264'].includes(enc));
  // Cached call returns the same value.
  assert.equal(await detectHardwareEncoder(), enc);
});
