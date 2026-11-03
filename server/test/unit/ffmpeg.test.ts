import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTranscodeArgs, choosePullUrl, parseProgress, parseRate, probeResultToSource } from '../../src/worker/ffmpeg.ts';
import { planLadder } from '../../src/worker/ladder.ts';

const base = { encoder: 'libx264' as const, x264Preset: 'veryfast', segmentSec: 2, listSize: 6,
  outputBase: 'http://127.0.0.1:1234/j/tok', initTag: 'abc', thumbnailEverySec: 10, tsOffsetSec: 12.5 };
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

test('abr args: one split, copy for source, aligned keyframes, var_stream_map with audio group', () => {
  const plan = planLadder({ videoCodec: 'H265', width: 1920, height: 1080, fps: 30, profile: 'Main', level: 120, hasAudio: true }, 'abr');
  const args = buildTranscodeArgs({ ...base, inputUrl: 'rtsp://ingest:8554/live/k', plan });
  assert.equal(after(args, '-i'), 'rtsp://ingest:8554/live/k');
  const encodes = plan.variants.filter((v) => v.kind === 'encode').length;
  assert.match(after(args, '-filter_complex')!, new RegExp(`^\\[0:v:0\\]split=${encodes + 1}`));
  const srcIdx = plan.variants.findIndex((v) => v.name === 'source');
  assert.equal(after(args, `-c:v:${srcIdx}`), 'copy');
  assert.equal(after(args, `-tag:v:${srcIdx}`), 'hvc1');
  plan.variants.forEach((v, i) => {
    if (v.kind === 'encode') {
      assert.equal(after(args, `-c:v:${i}`), 'libx264');
      assert.equal(after(args, `-b:v:${i}`), `${v.bitrateKbps}k`);
      assert.equal(after(args, `-force_key_frames:v:${i}`), 'expr:gte(t,n_forced*2)');
    }
  });
  const vsm = after(args, '-var_stream_map')!;
  assert.match(vsm, /v:0,agroup:aud,name:\S+/);
  assert.match(vsm, /a:0,agroup:aud,name:audio$/);
  assert.equal(after(args, '-hls_segment_type'), 'fmp4');
  assert.equal(after(args, '-hls_start_number_source'), 'epoch');
  assert.match(after(args, '-hls_flags')!, /omit_endlist/, 'never end the live playlist when ffmpeg stops');
  assert.equal(after(args, '-hls_fmp4_init_filename'), 'init_abc_%v.mp4');
  assert.equal(after(args, '-output_ts_offset'), '12.500');
  assert.equal(after(args, '-hls_segment_filename'), 'http://127.0.0.1:1234/j/tok/%v/seg_%d.m4s');
  assert.ok(args.includes('http://127.0.0.1:1234/j/tok/%v/index.m3u8'));
  assert.equal(args[args.length - 1], 'http://127.0.0.1:1234/j/tok/thumb.jpg');
  assert.ok(!args.includes('-skip_frame:v'));
});

test('passthrough args decode keyframes only and have no audio when source is silent', () => {
  const plan = planLadder({ videoCodec: 'H264', width: 1280, height: 720, fps: 30, hasAudio: false }, 'passthrough');
  const args = buildTranscodeArgs({ ...base, inputUrl: 'rtsp://x/live/k', plan });
  assert.equal(after(args, '-skip_frame:v'), 'nokey');
  assert.ok(!args.includes('0:a:0'));
  assert.equal(after(args, '-var_stream_map'), 'v:0,name:source');
});

test('nvenc encoder args', () => {
  const plan = planLadder({ videoCodec: 'VP8', width: 1280, height: 720, fps: 30, hasAudio: true }, 'abr');
  const args = buildTranscodeArgs({ ...base, encoder: 'h264_nvenc', inputUrl: 'rtsp://x', plan });
  assert.equal(after(args, '-c:v:0'), 'h264_nvenc');
});

test('parseRate and probeResultToSource', () => {
  assert.equal(parseRate('30000/1001').toFixed(2), '29.97');
  assert.equal(parseRate('0/0'), 0);
  const s = probeResultToSource([
    { codec_type: 'audio', codec_name: 'opus' },
    { codec_type: 'video', codec_name: 'av1', profile: 'Main', level: -99, width: 1280, height: 720, pix_fmt: 'yuv420p', avg_frame_rate: '0/0', r_frame_rate: '30/1' },
  ]);
  assert.deepEqual(s, { videoCodec: 'AV1', width: 1280, height: 720, fps: 30, profile: 'Main', level: undefined, pixFmt: 'yuv420p', hasAudio: true, audioCodec: 'Opus' });
  assert.throws(() => probeResultToSource([{ codec_type: 'audio', codec_name: 'aac' }]));
});

test('parseProgress', () => {
  const p = parseProgress('frame=100\nfps=29.97\nout_time_us=3336666\nspeed=1.01x\nprogress=continue\n');
  assert.deepEqual(p, { fps: 29.97, speed: 1.01, outTimeSec: 3.336666 });
});

test('choosePullUrl: H.264/H.265 over SRT (keeps DTS), others over RTSP', () => {
  const rtsp = 'rtsp://ingest:8554/live/live_abc';
  assert.equal(choosePullUrl({ videoCodec: 'H265', hasAudio: true, audioCodec: 'AAC' }, rtsp, 'srt://ingest:8890', 'transcoder', 's3cr3t'),
    'srt://ingest:8890?streamid=read:live/live_abc:transcoder:s3cr3t');
  assert.equal(choosePullUrl({ videoCodec: 'AV1', hasAudio: true, audioCodec: 'Opus' }, rtsp, 'srt://ingest:8890', 'transcoder', 's3cr3t'),
    'rtsp://transcoder:s3cr3t@ingest:8554/live/live_abc');
  // G.711 audio can't be carried by MediaMTX's SRT output → stay on RTSP
  assert.match(choosePullUrl({ videoCodec: 'H264', hasAudio: true, audioCodec: 'G711' }, rtsp, 'srt://ingest:8890', 'u', 'p'), /^rtsp:/);
  assert.match(choosePullUrl({ videoCodec: 'H264', hasAudio: false }, rtsp, null, 'u', 'p'), /^rtsp:/);
});

test('input args depend on transport', () => {
  const plan = planLadder({ videoCodec: 'H264', width: 1280, height: 720, fps: 30, hasAudio: true }, 'abr');
  const srt = buildTranscodeArgs({ ...base, inputUrl: 'srt://ingest:8890?streamid=read:live/k:u:p', plan });
  assert.ok(!srt.includes('-rtsp_transport'));
  assert.equal(after(srt, '-timeout'), '5000000');
  const rtsp = buildTranscodeArgs({ ...base, inputUrl: 'rtsp://ingest:8554/live/k', plan });
  assert.equal(after(rtsp, '-rtsp_transport'), 'tcp');
});

test('multitrack probe: the largest track is primary, others become extra tracks; args map each track', () => {
  const s = probeResultToSource([
    { codec_type: 'video', codec_name: 'h264', width: 640, height: 360, avg_frame_rate: '30/1', profile: 'Main', level: 30 },
    { codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, avg_frame_rate: '30/1', profile: 'High', level: 31 },
    { codec_type: 'audio', codec_name: 'aac' },
  ]);
  assert.equal(s.width, 1280);
  assert.equal(s.track, 1);
  assert.deepEqual(s.extraTracks?.map((t) => [t.track, t.width]), [[0, 640]]);
  const plan = planLadder(s, 'abr');
  const args = buildTranscodeArgs({ ...base, inputUrl: 'srt://x', plan, primaryTrack: s.track });
  const fc = after(args, '-filter_complex')!;
  assert.match(fc, /^\[0:v:1\]split=/, 'encodes decode the primary (largest) track');
  assert.ok(args.includes('0:v:1') && args.includes('0:v:0'), 'both provided tracks are mapped');
});
