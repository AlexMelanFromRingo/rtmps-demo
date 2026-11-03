// FFmpeg/ffprobe integration: argument building (pure, unit tested),
// source probing, hardware encoder detection and progress parsing.
import { execFile } from 'node:child_process';
import { codecName } from './codecs.ts';
import { AUDIO_DIR, AUDIO_GROUP } from './master.ts';
import type { LadderPlan, ProbedSource, Variant } from './ladder.ts';

export type Encoder = 'libx264' | 'h264_nvenc' | 'h264_qsv';

export type TranscodeArgsOptions = {
  inputUrl: string;
  plan: LadderPlan;
  encoder: Encoder;
  x264Preset: string;
  segmentSec: number;
  listSize: number;
  /** http://127.0.0.1:<port>/j/<token> — the worker's local segment receiver. */
  outputBase: string;
  /** Unique per attempt so a failed-over transcode never reuses init segments. */
  initTag: string;
  thumbnailEverySec: number;
  /** Seconds since the broadcast started: keeps timestamps monotonic across failovers. */
  tsOffsetSec: number;
};

function encoderArgs(encoder: Encoder, i: number, v: Variant, preset: string, gop: number): string[] {
  const rate = [
    `-b:v:${i}`, `${v.bitrateKbps}k`,
    `-maxrate:v:${i}`, `${v.maxrateKbps}k`,
    `-bufsize:v:${i}`, `${v.bufsizeKbps}k`,
    `-g:v:${i}`, String(gop),
  ];
  const level = ((v.h264Level ?? 40) / 10).toFixed(1);
  switch (encoder) {
    case 'h264_nvenc':
      return [`-c:v:${i}`, 'h264_nvenc', `-preset:v:${i}`, 'p4', `-tune:v:${i}`, 'll', `-rc:v:${i}`, 'vbr',
        `-profile:v:${i}`, 'high', `-level:v:${i}`, level, `-bf:v:${i}`, '0', `-forced-idr:v:${i}`, '1', ...rate];
    case 'h264_qsv':
      return [`-c:v:${i}`, 'h264_qsv', `-preset:v:${i}`, 'faster', `-profile:v:${i}`, 'high', `-level:v:${i}`, level,
        `-bf:v:${i}`, '0', `-idr_interval:v:${i}`, '0', ...rate];
    case 'libx264':
    default:
      return [`-c:v:${i}`, 'libx264', `-preset:v:${i}`, preset, `-profile:v:${i}`, 'high', `-level:v:${i}`, level,
        `-keyint_min:v:${i}`, String(gop), `-sc_threshold:v:${i}`, '0', `-bf:v:${i}`, '2',
        `-x264-params:v:${i}`, 'rc-lookahead=20:aq-mode=3', ...rate];
  }
}

/** Protocol options for pulling from an ingest node (5 s I/O timeout → fast failure detection). */
export function inputArgs(url: string): string[] {
  if (url.startsWith('rtsp://')) return ['-rtsp_transport', 'tcp', '-timeout', '5000000'];
  if (url.startsWith('srt://')) return ['-timeout', '5000000'];
  return [];
}

// MPEG-TS (SRT) carries DTS, RTP (RTSP) does not: copying H.264/H.265 with
// B-frames from RTSP yields broken timestamps, so pull those codecs over SRT.
// MediaMTX's SRT output supports these audio codecs.
const SRT_VIDEO = new Set(['H264', 'H265']);
const SRT_AUDIO = new Set(['AAC', 'Opus', 'MP3', 'AC3']);

export function choosePullUrl(src: { videoCodec: string; hasAudio: boolean; audioCodec?: string | null | undefined },
  rtspUrl: string, srtBase: string | null, user: string, pass: string): string {
  const path = new URL(rtspUrl).pathname.replace(/^\//, '');
  const audioOk = !src.hasAudio || SRT_AUDIO.has(src.audioCodec ?? '');
  if (srtBase && SRT_VIDEO.has(src.videoCodec) && audioOk) {
    return `${srtBase}?streamid=read:${path}:${user}:${pass}`;
  }
  const u = new URL(rtspUrl);
  u.username = user;
  u.password = pass;
  return u.toString();
}

export function buildTranscodeArgs(o: TranscodeArgsOptions): string[] {
  const { plan } = o;
  const encodes = plan.variants.filter((v) => v.kind === 'encode');
  const hasAudio = plan.audio !== null;

  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'warning',
    '-progress', 'pipe:1', '-stats_period', '5',
    ...inputArgs(o.inputUrl),
    ...(plan.decodeKeyframesOnly ? ['-skip_frame:v', 'nokey'] : []),
    '-i', o.inputUrl,
  ];

  // One decode, split into every encoded rendition + the thumbnail branch.
  const branches = encodes.length + 1;
  const labels = Array.from({ length: branches }, (_, i) => `[s${i}]`).join('');
  const chains = encodes.map((v, i) =>
    `[s${i}]fps=${v.fps},scale=${v.width}:${v.height}:flags=bicubic,format=yuv420p,setsar=1[o${i}]`);
  chains.push(`[s${encodes.length}]fps=1/${o.thumbnailEverySec},scale=w=640:h=360:force_original_aspect_ratio=decrease,format=yuvj420p[thumb]`);
  args.push('-filter_complex', `[0:v:0]split=${branches}${labels};${chains.join(';')}`);

  // Video maps in master order (copy maps the source directly).
  let e = 0;
  for (const v of plan.variants) {
    if (v.kind === 'copy') args.push('-map', '0:v:0');
    else args.push('-map', `[o${e++}]`);
  }
  if (hasAudio) args.push('-map', '0:a:0');

  // Per-output-stream codec settings.
  e = 0;
  plan.variants.forEach((v, i) => {
    if (v.kind === 'copy') {
      args.push(`-c:v:${i}`, 'copy');
      if (v.codec === 'H265') args.push(`-tag:v:${i}`, 'hvc1'); // Apple requires hvc1 in fMP4
    } else {
      const gop = Math.max(1, Math.round(v.fps * o.segmentSec));
      args.push(...encoderArgs(o.encoder, i, v, o.x264Preset, gop));
      // Keyframes on exact segment boundaries in every rendition → aligned ABR switching.
      args.push(`-force_key_frames:v:${i}`, `expr:gte(t,n_forced*${o.segmentSec})`);
      e++;
    }
  });
  if (hasAudio) {
    args.push('-c:a:0', 'aac', '-b:a:0', `${plan.audio!.bitrateKbps}k`, '-ac:a:0', '2', '-ar:a:0', '48000',
      '-filter:a:0', 'aresample=async=1:first_pts=0');
  }

  const vsm = plan.variants.map((v, i) => `v:${i},${hasAudio ? `agroup:${AUDIO_GROUP},` : ''}name:${v.name}`);
  if (hasAudio) vsm.push(`a:0,agroup:${AUDIO_GROUP},name:${AUDIO_DIR}`);

  args.push(
    '-max_muxing_queue_size', '4096',
    '-output_ts_offset', o.tsOffsetSec.toFixed(3),
    '-f', 'hls',
    '-hls_time', String(o.segmentSec),
    '-hls_list_size', String(o.listSize),
    '-hls_delete_threshold', '4',
    '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', `init_${o.initTag}_%v.mp4`,
    // omit_endlist: stopping ffmpeg (failover, deploy, re-plan) must NOT tell
    // players the live stream is over.
    '-hls_flags', 'independent_segments+program_date_time+delete_segments+discont_start+omit_endlist',
    // Epoch-based media sequence: a failed-over transcode continues with
    // higher sequence numbers instead of colliding with cached segments.
    '-hls_start_number_source', 'epoch',
    '-var_stream_map', vsm.join(' '),
    '-method', 'PUT', '-http_persistent', '1', '-ignore_io_errors', '1',
    '-hls_segment_filename', `${o.outputBase}/%v/seg_%d.m4s`,
    `${o.outputBase}/%v/index.m3u8`,
  );

  // Second output: periodically refreshed thumbnail.
  args.push('-map', '[thumb]', '-c:v', 'mjpeg', '-q:v', '5', '-update', '1', '-f', 'image2', `${o.outputBase}/thumb.jpg`);
  return args;
}

// ── ffprobe ─────────────────────────────────────────────────────────────────

type ProbeStream = {
  codec_type?: string; codec_name?: string; profile?: string; level?: number;
  width?: number; height?: number; pix_fmt?: string; avg_frame_rate?: string; r_frame_rate?: string;
};

export function parseRate(rate: string | undefined): number {
  if (!rate) return 0;
  const [n, d] = rate.split('/').map(Number);
  if (!n || !Number.isFinite(n)) return 0;
  const v = d ? n / d : n;
  return Number.isFinite(v) ? v : 0;
}

export function probeResultToSource(streams: ProbeStream[]): ProbedSource {
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  if (!video) throw new Error('source has no video track');
  const avg = parseRate(video.avg_frame_rate);
  const real = parseRate(video.r_frame_rate);
  const fps = avg > 1 && avg <= 240 ? avg : real > 1 && real <= 240 ? real : 30;
  return {
    videoCodec: codecName(video.codec_name) ?? 'unknown',
    width: video.width ?? 0,
    height: video.height ?? 0,
    fps: Math.round(fps * 1000) / 1000,
    profile: video.profile,
    level: video.level !== undefined && video.level >= 0 ? video.level : undefined,
    pixFmt: video.pix_fmt,
    hasAudio: audio !== undefined,
    audioCodec: codecName(audio?.codec_name),
  };
}

export function probeSource(ffprobePath: string, url: string, timeoutMs = 15_000): Promise<ProbedSource> {
  return new Promise((resolve, reject) => {
    execFile(ffprobePath, [
      '-v', 'error', '-rtsp_transport', 'tcp', '-timeout', '5000000',
      '-analyzeduration', '3000000', '-probesize', '8000000',
      '-show_streams', '-of', 'json', url,
    ], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`ffprobe failed: ${(stderr || err.message).toString().trim().slice(-500)}`));
      try {
        const parsed = JSON.parse(stdout) as { streams?: ProbeStream[] };
        resolve(probeResultToSource(parsed.streams ?? []));
      } catch (e) {
        reject(e as Error);
      }
    });
  });
}

// ── encoder detection ───────────────────────────────────────────────────────
// Listing in `ffmpeg -encoders` does not mean the hardware exists, so run a
// tiny real encode and trust the exit code.
export function probeEncoder(ffmpegPath: string, encoder: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=256x144:rate=15',
      '-t', '0.2', '-c:v', encoder, '-f', 'null', '-'], { timeout: 15_000 }, (err) => resolve(!err));
  });
}

export async function detectEncoder(ffmpegPath: string, wanted: string): Promise<Encoder> {
  if (wanted === 'libx264' || wanted === 'h264_nvenc' || wanted === 'h264_qsv') return wanted;
  for (const candidate of ['h264_nvenc', 'h264_qsv'] as const) {
    if (await probeEncoder(ffmpegPath, candidate)) return candidate;
  }
  return 'libx264';
}

// ── progress ────────────────────────────────────────────────────────────────
export type Progress = { fps: number | null; speed: number | null; outTimeSec: number | null };

/** Parses one `-progress` block (key=value lines). */
export function parseProgress(block: string): Progress {
  const kv = new Map<string, string>();
  for (const line of block.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const num = (v: string | undefined) => {
    if (v === undefined) return null;
    const n = Number.parseFloat(v.replace(/x$/, ''));
    return Number.isFinite(n) ? n : null;
  };
  const us = num(kv.get('out_time_us'));
  return { fps: num(kv.get('fps')), speed: num(kv.get('speed')), outTimeSec: us === null ? null : us / 1e6 };
}
