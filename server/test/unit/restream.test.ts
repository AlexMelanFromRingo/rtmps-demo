import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRestreamArgs, restreamTarget, restreamVideoMode, type Destination } from '../../src/worker/restream.ts';

const dest = (over: Partial<Destination>): Destination => ({
  id: 'd1', service: 'twitch', url: 'rtmp://live.twitch.tv/app', key: 'live_123_secret', transcode: 'auto', ...over,
});
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

test('auto mode copies H.264 everywhere, re-encodes HEVC/AV1 for Twitch/Kick, copies them for YouTube', () => {
  assert.equal(restreamVideoMode(dest({}), 'H264'), 'copy');
  assert.equal(restreamVideoMode(dest({}), 'H265'), 'h264');
  assert.equal(restreamVideoMode(dest({ service: 'kick' }), 'AV1'), 'h264');
  assert.equal(restreamVideoMode(dest({ service: 'youtube' }), 'AV1'), 'copy');
  assert.equal(restreamVideoMode(dest({ service: 'youtube' }), 'H265'), 'copy');
  assert.equal(restreamVideoMode(dest({ service: 'custom', url: 'srt://x.example.com:9000' }), 'H265'), 'copy');
  assert.equal(restreamVideoMode(dest({ service: 'custom', url: 'srt://x.example.com:9000' }), 'AV1'), 'h264', 'AV1 in MPEG-TS is not standard');
  assert.equal(restreamVideoMode(dest({ transcode: 'copy' }), 'VP8'), 'h264', 'VP8 can never be copied');
  assert.equal(restreamVideoMode(dest({ transcode: 'h264' }), 'H264'), 'h264');
});

test('targets: RTMP appends the key as the stream name, SRT puts it into streamid', () => {
  assert.deepEqual(restreamTarget(dest({ url: 'rtmp://live.twitch.tv/app/' })), { url: 'rtmp://live.twitch.tv/app/live_123_secret', format: 'flv' });
  assert.deepEqual(restreamTarget(dest({ url: 'srt://x.example.com:9000?latency=200000', key: 'a b' })),
    { url: 'srt://x.example.com:9000?latency=200000&streamid=a%20b', format: 'mpegts' });
});

test('ffmpeg args: copy video + AAC audio to FLV; silent audio for video-only sources', () => {
  const a = buildRestreamArgs('srt://ingest:8890?streamid=read:live/k:u:p', dest({}), { videoCodec: 'H264', fps: 30, hasAudio: true });
  assert.equal(after(a, '-c:v'), 'copy');
  assert.equal(after(a, '-c:a'), 'aac');
  assert.equal(a[a.length - 1], 'rtmp://live.twitch.tv/app/live_123_secret');
  assert.equal(after(a, '-f'), 'flv');
  const b = buildRestreamArgs('rtsp://ingest:8554/live/k', dest({}), { videoCodec: 'AV1', fps: 60, hasAudio: false });
  assert.equal(after(b, '-c:v'), 'libx264');
  assert.ok(b.includes('anullsrc=channel_layout=stereo:sample_rate=48000'));
  assert.ok(b.includes('-shortest'));
  assert.equal(after(b, '-rtsp_transport'), 'tcp');
  assert.equal(after(b, '-g'), '120');
});
