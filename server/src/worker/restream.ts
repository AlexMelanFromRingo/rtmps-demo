// Multistream (Streamlabs/Restream-style): while a broadcast is live, push it
// to the channel's external destinations (Twitch, YouTube, Kick, any RTMP(S)/SRT).
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { config } from '../config.ts';
import { query } from '../lib/db.ts';
import { assertPublicTarget } from '../lib/egress.ts';
import type { Logger } from '../lib/log.ts';
import { redact } from '../lib/redact.ts';
import { open } from '../lib/secretbox.ts';
import { inputArgs, parseProgress } from './ffmpeg.ts';
import type { ProbedSource } from './ladder.ts';

export const RESTREAM_PURPOSE = 'restream';

export type Destination = {
  id: string; service: 'twitch' | 'youtube' | 'kick' | 'custom'; url: string; key: string; transcode: 'auto' | 'copy' | 'h264';
};

export type RestreamState = { id: string; state: 'connecting' | 'live' | 'error'; error: string | null; since: string };

/** Copy the video when the destination can take the codec; otherwise H.264. */
export function restreamVideoMode(d: Pick<Destination, 'service' | 'transcode' | 'url'>, codec: string): 'copy' | 'h264' {
  if (d.transcode === 'h264') return 'h264';
  if (codec === 'VP8') return 'h264';                      // FLV/MPEG-TS can't carry VP8
  if (d.transcode === 'copy') return 'copy';
  if (codec === 'H264') return 'copy';
  const srt = d.url.startsWith('srt://');
  // HEVC/AV1 over Enhanced RTMP: YouTube and custom servers accept it; Twitch/Kick
  // only take H.264 outside their own multi-encode beta programmes.
  if ((codec === 'H265' || codec === 'AV1') && !srt && (d.service === 'youtube' || d.service === 'custom')) return 'copy';
  if (codec === 'H265' && srt) return 'copy';
  return 'h264';
}

export function restreamTarget(d: Pick<Destination, 'url' | 'key'>): { url: string; format: 'flv' | 'mpegts' } {
  if (d.url.startsWith('srt://')) {
    const sep = d.url.includes('?') ? '&' : '?';
    return { url: d.key ? `${d.url}${sep}streamid=${encodeURIComponent(d.key)}` : d.url, format: 'mpegts' };
  }
  return { url: `${d.url.replace(/\/+$/, '')}/${d.key}`, format: 'flv' };
}

export function buildRestreamArgs(inputUrl: string, d: Destination, src: Pick<ProbedSource, 'videoCodec' | 'fps' | 'hasAudio'>): string[] {
  const target = restreamTarget(d);
  const mode = restreamVideoMode(d, src.videoCodec);
  const fps = src.fps > 0 ? Math.min(60, src.fps) : 30;
  const gop = Math.round(fps * 2);
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'warning', '-progress', 'pipe:1', '-stats_period', '5',
    ...inputArgs(inputUrl), '-i', inputUrl];
  // Platforms expect an audio track: synthesize silence for video-only sources.
  if (!src.hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  args.push('-map', '0:v:0', '-map', src.hasAudio ? '0:a:0' : '1:a:0');
  if (mode === 'copy') {
    args.push('-c:v', 'copy');
  } else {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
      '-vf', "scale=-2:'min(ih,1080)'", '-fpsmax', '60',
      '-b:v', '6000k', '-maxrate', '6000k', '-bufsize', '12000k', '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0');
  }
  args.push('-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2');
  if (!src.hasAudio) args.push('-shortest');
  if (target.format === 'flv') args.push('-flvflags', 'no_duration_filesize');
  args.push('-f', target.format, target.url);
  return args;
}

type Running = {
  dest: Destination; hash: string; proc: ChildProcess | null; state: RestreamState;
  restartTimer: NodeJS.Timeout | null; failures: number; stopped: boolean;
};

const specHash = (d: Destination) => createHash('sha256').update(JSON.stringify([d.url, d.key, d.transcode, d.service])).digest('hex');

export class RestreamManager {
  private readonly running = new Map<string, Running>();
  private readonly channelId: string;
  private readonly inputUrl: string;
  private readonly src: ProbedSource;
  private readonly log: Logger;
  private closed = false;

  constructor(opts: { channelId: string; inputUrl: string; src: ProbedSource; log: Logger }) {
    this.channelId = opts.channelId;
    this.inputUrl = opts.inputUrl;
    this.src = opts.src;
    this.log = opts.log;
  }

  statuses(): RestreamState[] {
    return [...this.running.values()].map((r) => r.state);
  }

  /** Reconcile running pushes with the channel's enabled destinations (picks up studio edits live). */
  async sync(): Promise<void> {
    if (this.closed) return;
    const rows = await query<{ id: string; service: Destination['service']; url: string; stream_key_enc: string; transcode: Destination['transcode'] }>(
      `SELECT id, service, url, stream_key_enc, transcode FROM restream_destinations
        WHERE channel_id = $1 AND enabled ORDER BY created_at LIMIT $2`, [this.channelId, config.worker.restreamMax]);
    const wanted = new Map<string, Destination>();
    for (const r of rows) {
      try {
        wanted.set(r.id, { id: r.id, service: r.service, url: r.url, key: open(r.stream_key_enc, RESTREAM_PURPOSE), transcode: r.transcode });
      } catch {
        this.log.warn({ destination: r.id }, 'cannot decrypt destination key — skipped');
      }
    }
    for (const [id, r] of this.running) {
      const want = wanted.get(id);
      if (!want || specHash(want) !== r.hash) this.stopOne(id);
    }
    for (const [id, d] of wanted) if (!this.running.has(id)) this.startOne(d);
  }

  stop(): void {
    this.closed = true;
    for (const id of [...this.running.keys()]) this.stopOne(id);
  }

  private startOne(d: Destination): void {
    const r: Running = {
      dest: d, hash: specHash(d), proc: null, failures: 0, restartTimer: null, stopped: false,
      state: { id: d.id, state: 'connecting', error: null, since: new Date().toISOString() },
    };
    this.running.set(d.id, r);
    void this.launch(r);
  }

  private async launch(r: Running): Promise<void> {
    if (r.stopped || this.closed) return;
    const setState = (state: RestreamState['state'], error: string | null = null) => {
      if (r.state.state !== state || r.state.error !== error) r.state = { id: r.dest.id, state, error, since: new Date().toISOString() };
    };
    try {
      await assertPublicTarget(r.dest.url);
    } catch (err) {
      setState('error', (err as Error).message);
      return this.scheduleRestart(r);
    }
    const scrub = (s: string) => redact(r.dest.key ? s.split(r.dest.key).join('***') : s);
    const child = spawn(config.worker.ffmpegPath, buildRestreamArgs(this.inputUrl, r.dest, this.src), { stdio: ['ignore', 'pipe', 'pipe'] });
    r.proc = child;
    setState('connecting');
    const started = Date.now();
    let stderrTail = '';
    let block = '';
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      block += chunk;
      let idx: number;
      while ((idx = block.search(/progress=(continue|end)\n/)) !== -1) {
        const end = block.indexOf('\n', idx) + 1;
        const p = parseProgress(block.slice(0, end));
        block = block.slice(end);
        if ((p.outTimeSec ?? 0) > 0) { setState('live'); r.failures = 0; }
      }
    });
    child.stderr!.setEncoding('utf8').on('data', (c: string) => { stderrTail = (stderrTail + c).slice(-2000); });
    child.on('error', (err) => { stderrTail += `\nspawn error: ${err.message}`; });
    child.on('close', (code) => {
      r.proc = null;
      if (r.stopped || this.closed) return;
      const last = scrub(stderrTail).trim().split('\n').filter(Boolean).slice(-2).join(' | ');
      setState('error', last || `ffmpeg завершился с кодом ${code}`);
      this.log.warn({ destination: r.dest.id, service: r.dest.service, code, ranSec: Math.round((Date.now() - started) / 1000), err: last },
        'restream stopped');
      if (Date.now() - started > 60_000) r.failures = 0;
      this.scheduleRestart(r);
    });
  }

  private scheduleRestart(r: Running): void {
    if (r.stopped || this.closed) return;
    r.failures++;
    const delay = Math.min(60_000, 5000 * 2 ** Math.min(r.failures - 1, 4));
    r.restartTimer = setTimeout(() => void this.launch(r), delay);
  }

  private stopOne(id: string): void {
    const r = this.running.get(id);
    if (!r) return;
    r.stopped = true;
    if (r.restartTimer) clearTimeout(r.restartTimer);
    r.proc?.kill('SIGTERM');
    this.running.delete(id);
  }
}
