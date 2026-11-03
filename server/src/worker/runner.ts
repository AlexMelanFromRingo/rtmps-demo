// Executes one claimed transcode job end-to-end:
// probe source → plan ladder → run ffmpeg → publish HLS → keep lease alive.
import { spawn } from 'node:child_process';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import { publishChannelEvent } from '../lib/events.ts';
import { log as rootLog } from '../lib/log.ts';
import { redact } from '../lib/redact.ts';
import { deleteObject, getObjectText, objectKeys, putObject } from '../lib/s3.ts';
import { RestreamManager } from './restream.ts';
import { VodRecorder } from './vod.ts';
import { buildTranscodeArgs, choosePullUrl, parseProgress, probeSource, type Encoder, type Progress } from './ffmpeg.ts';
import { parseRungs, planLadder, sourceUpgraded } from './ladder.ts';
import { JobOutput } from './output.ts';
import type { SegmentReceiver } from './receiver.ts';
import {
  heartbeat, jobState, loadJobContext, markBroadcastReady, releaseJob, setJobState, updateBroadcastSource, type JobRow,
} from './queue.ts';
import { metrics } from './metrics.ts';

const rungs = parseRungs(process.env.LADDER);

export type RunnerDeps = {
  receiver: SegmentReceiver;
  encoder: Encoder;
  isShuttingDown: () => boolean;
  /** Aborted on worker shutdown: stop ffmpeg and hand the job back immediately. */
  shutdown: AbortSignal;
  /** No full transcoding capacity: serve the source only (remux, ≤480p encode if unavoidable). */
  degraded: boolean;
};

/** rtsp://host/path → rtsp://transcoder:<secret>@host/path */
export function withReadCredentials(url: string): string {
  const u = new URL(url);
  u.username = config.worker.ingestReadUser;
  u.password = config.internalSecret;
  return u.toString();
}

/**
 * Encoders run at a lower CPU priority than this process: a worker is meant
 * to be 100% busy, and the lease heartbeat must still run on time.
 */
export function lowerPriority(pid: number | undefined): void {
  if (!pid) return;
  try { os.setPriority(pid, 10); } catch { /* not permitted: keep default */ }
}

export function backoffSec(attempts: number): number {
  return Math.min(15, 2 ** Math.max(0, attempts - 1));
}

type FfmpegResult = { code: number | null; signal: NodeJS.Signals | null; stderrTail: string; ranMs: number };

function runFfmpeg(args: string[], signal: AbortSignal, onProgress: (p: Progress) => void): Promise<FfmpegResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(config.worker.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    lowerPriority(child.pid);
    const tail: string[] = [];
    let block = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      block += chunk;
      let idx: number;
      while ((idx = block.search(/progress=(continue|end)\n/)) !== -1) {
        const end = block.indexOf('\n', idx) + 1;
        onProgress(parseProgress(block.slice(0, end)));
        block = block.slice(end);
      }
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) if (line.trim()) tail.push(line.trim());
      if (tail.length > 30) tail.splice(0, tail.length - 30);
    });
    let killTimer: NodeJS.Timeout | undefined;
    const stop = () => {
      child.kill('SIGTERM'); // ffmpeg finalises the current segment on SIGTERM
      killTimer = setTimeout(() => child.kill('SIGKILL'), 4000);
    };
    if (signal.aborted) stop();
    signal.addEventListener('abort', stop, { once: true });
    child.on('error', (err) => tail.push(`spawn error: ${err.message}`));
    child.on('close', (code, sig) => {
      clearTimeout(killTimer);
      signal.removeEventListener('abort', stop);
      resolve({ code, signal: sig, stderrTail: tail.slice(-8).join('\n'), ranMs: Date.now() - started });
    });
  });
}

export async function runJob(job: JobRow, deps: RunnerDeps): Promise<void> {
  const workerId = config.worker.id;
  const log = rootLog.child({ job: job.id, broadcast: job.broadcast_id, attempt: job.attempts });
  metrics.activeJobs.inc();
  const kill = new AbortController();
  const onShutdown = () => kill.abort();
  deps.shutdown.addEventListener('abort', onShutdown, { once: true });
  const jobStarted = Date.now();
  let leaseLost = false;
  let progress: Progress = { fps: null, speed: null, outTimeSec: null, frames: null };
  let lastProgressAt = 0;
  let output: JobOutput | null = null;
  let token: string | null = null;
  let renditionCount = 0;
  let sourceChanged = false;
  let watch: NodeJS.Timeout | undefined;
  let vodTimer: NodeJS.Timeout | undefined;
  let restreamTimer: NodeJS.Timeout | undefined;
  let vod: VodRecorder | null = null;
  let restream: RestreamManager | null = null;

  // Lease keeper + fencing. A lease is renewed every heartbeatSec; the DB
  // sets its expiry to (renewal start + leaseSec) at the earliest. If we have
  // not renewed successfully for (leaseSec - heartbeatSec - 1) s we stop on our
  // own BEFORE the lease can be taken by another worker — also when the
  // renewal query hangs instead of failing.
  const fenceMs = Math.max(2000, (config.worker.leaseSec - config.worker.heartbeatSec - 1) * 1000);
  let lastRenewStart = Date.now();
  let renewing = false;
  let endedByControl = false;
  const fenceOff = (why: string) => {
    if (leaseLost) return;
    log.warn({ why }, 'lost the job lease — stopping and discarding pending output');
    leaseLost = true;
    output?.abort(); // a fenced worker must not write anything else
    kill.abort();
  };
  // The control plane finished/cancelled the job (stream ended or moved): nobody
  // else owns it, so stop gracefully and keep the tail of the recording.
  const endGracefully = () => {
    if (leaseLost) return;
    log.info('job ended by the control plane — finishing gracefully');
    leaseLost = true;
    endedByControl = true;
    kill.abort();
  };
  const hb = setInterval(() => {
    if (!renewing && !leaseLost) {
      renewing = true;
      const started = Date.now();
      const stats = {
        fps: progress.fps, speed: progress.speed, encoder: deps.encoder, renditions: renditionCount, degraded: deps.degraded,
        uploads: output?.stats.uploads ?? 0, uploadFailures: output?.stats.failures ?? 0,
        pendingUploads: output?.stats.pending ?? 0, worker: workerId,
        restreams: restream?.statuses() ?? [],
      };
      heartbeat(job.id, job.lease_id, config.worker.leaseSec, stats).then(async (owned) => {
        if (owned) { lastRenewStart = started; return; }
        const state = await jobState(job.id).catch(() => null);
        if (state && (state.state === 'finished' || state.state === 'cancelled') && state.lease_id === null) endGracefully();
        else fenceOff('job re-claimed by another worker');
      }).catch((err: unknown) => {
        log.warn({ err: (err as Error).message }, 'lease heartbeat failed');
      }).finally(() => { renewing = false; });
    }
    if (Date.now() - lastRenewStart > fenceMs) fenceOff('could not renew the lease in time');

    if (!output || kill.signal.aborted) return;
    // Stall watchdog: neither segments nor encoder progress for a long time → restart.
    // (A heavily loaded encoder that still advances is slow, not stuck.)
    // Before the first segment a heavy ladder on a busy host may need a while
    // (decoder + N encoders warming up); ffmpeg itself exits on dead input (-timeout).
    const stallMs = output.stats.lastSegmentAt ? Math.max(20_000, config.worker.segmentSec * 8000) : 60_000;
    const lastActivity = Math.max(output.stats.lastSegmentAt ?? 0, lastProgressAt, jobStarted);
    if (Date.now() - lastActivity > stallMs) {
      log.warn({ stallMs }, 'transcode stalled (no progress, no segments) — restarting');
      kill.abort();
    }
    // Upload watchdog: object storage stuck or far behind → restart instead of
    // buffering media in memory until the process dies.
    const st = output.stats;
    if (st.pending > 0 && Date.now() - (st.lastUploadAt ?? jobStarted) > 20_000) {
      log.warn({ pending: st.pending }, 'object storage not accepting uploads — restarting transcode');
      output.abort();
      kill.abort();
    } else if (st.pendingBytes > 256 * 1024 * 1024) {
      log.warn({ pendingBytes: st.pendingBytes }, 'upload backlog too large — restarting transcode');
      output.abort();
      kill.abort();
    }
  }, config.worker.heartbeatSec * 1000);

  try {
    if (job.attempts > config.control.maxJobAttempts) {
      await setJobState(job.id, job.lease_id, 'failed', 'too many attempts');
      return;
    }
    const ctx = await loadJobContext(job.id);
    if (!ctx || ctx.broadcast_status === 'ended') {
      await setJobState(job.id, job.lease_id, 'cancelled');
      return;
    }

    const src = await probeSource(config.worker.ffprobePath, withReadCredentials(job.source_url));
    const sourceUrl = choosePullUrl(src, job.source_url, job.source_srt_url, config.worker.ingestReadUser, config.internalSecret);
    log.info({ src, transport: sourceUrl.slice(0, sourceUrl.indexOf(':')) }, 'source probed');
    // Low-latency channels: 1 s segments (≈ 3–4 s glass-to-glass instead of 6–10 s).
    const latencyMode = ctx.low_latency ? 'low' as const : 'normal' as const;
    const segmentSec = ctx.low_latency ? config.worker.lowLatencySegmentSec : config.worker.segmentSec;
    const listSize = ctx.low_latency ? Math.max(config.worker.listSize, 10) : config.worker.listSize;
    await updateBroadcastSource(job.broadcast_id, src, latencyMode);
    await publishChannelEvent(ctx.channel_id, { kind: 'state' });

    const plan = planLadder(src, deps.degraded ? 'degraded' : ctx.transcode_mode, rungs);
    if (deps.degraded) log.warn('no transcoding capacity — serving the source only (degraded)');
    renditionCount = plan.variants.length;
    token = randomUUID();

    // VOD: record every segment; continue what earlier attempts recorded.
    if (ctx.vod_enabled) {
      vod = new VodRecorder({
        prefix: objectKeys.prefix(job.broadcast_id),
        log,
        put: (key, body) => putObject(key, body, 'application/vnd.apple.mpegurl', 'public, max-age=2'),
        get: getObjectText,
      });
      await vod.resume([...plan.variants.map((v) => v.name), ...(plan.audio ? ['audio'] : [])]);
      vodTimer = setInterval(() => void vod?.flush(), 10_000);
    }

    // Multistream to the channel's external destinations while we are live.
    restream = new RestreamManager({ channelId: ctx.channel_id, inputUrl: sourceUrl, src, log });
    await restream.sync().catch((err: Error) => log.warn({ err: err.message }, 'restream sync failed'));
    restreamTimer = setInterval(() => {
      restream?.sync().catch((err: Error) => log.warn({ err: err.message }, 'restream sync failed'));
    }, 15_000);

    output = new JobOutput({
      vod,
      prefix: objectKeys.prefix(job.broadcast_id),
      plan,
      log,
      put: async (key, body, contentType, cacheControl, signal) => {
        const t = process.hrtime.bigint();
        await putObject(key, body, contentType, cacheControl, signal);
        metrics.uploadSeconds.observe(Number(process.hrtime.bigint() - t) / 1e9);
      },
      del: (key, signal) => deleteObject(key, signal),
      onReady: async ({ variants, observed }) => {
        await markBroadcastReady(job.broadcast_id, variants, observed);
        await publishChannelEvent(ctx.channel_id, { kind: 'state' });
      },
    });
    deps.receiver.register(token, output);

    const args = buildTranscodeArgs({
      inputUrl: sourceUrl,
      plan,
      encoder: deps.encoder,
      x264Preset: config.worker.x264Preset,
      segmentSec,
      listSize,
      keepSegments: ctx.vod_enabled,
      primaryTrack: src.track ?? 0,
      outputBase: deps.receiver.baseUrl(token),
      initTag: `${Date.now().toString(36)}${job.attempts}`,
      thumbnailEverySec: config.worker.thumbnailEverySec,
      tsOffsetSec: Math.max(0, (Date.now() - new Date(ctx.broadcast_started_at).getTime()) / 1000),
    });
    log.info({ variants: plan.variants.map((v) => `${v.name}:${v.kind}:${v.codec}`), encoder: deps.encoder }, 'transcode starting');

    // Re-probe the source periodically (often at first, then every minute) and
    // re-plan the ladder if it got better than what we planned for.
    const probeUrl = withReadCredentials(job.source_url);
    const watchStarted = Date.now();
    let lastProbe = Date.now();
    let probing = false;
    watch = setInterval(() => {
      const interval = Date.now() - watchStarted < 120_000 ? 10_000 : 60_000;
      if (probing || kill.signal.aborted || Date.now() - lastProbe < interval) return;
      probing = true;
      lastProbe = Date.now();
      probeSource(config.worker.ffprobePath, probeUrl).then((now) => {
        if (!kill.signal.aborted && sourceUpgraded(src, now)) {
          log.info({ from: `${src.videoCodec} ${src.width}x${src.height}`, to: `${now.videoCodec} ${now.width}x${now.height}` },
            'source changed — re-planning the ladder');
          sourceChanged = true;
          kill.abort();
        }
      }).catch(() => { /* transient; ffmpeg itself detects a dead source */ }).finally(() => { probing = false; });
    }, 5000);

    const result = await runFfmpeg(args, kill.signal, (p) => {
      // Frames advance before the HLS muxer writes anything; out_time after.
      if ((p.outTimeSec ?? 0) > (progress.outTimeSec ?? 0) || (p.frames ?? 0) > (progress.frames ?? 0)) lastProgressAt = Date.now();
      progress = p;
    });
    clearInterval(watch);
    restream.stop();
    if (leaseLost && !endedByControl) output.abort();
    else {
      await output.drain();
      clearInterval(vodTimer);
      await vod?.flush(); // the recording includes the very last segments
    }
    log.info({ code: result.code, signal: result.signal, ranSec: Math.round(result.ranMs / 1000) }, 'ffmpeg exited');
    metrics.ffmpegExits.inc({ reason: leaseLost ? 'lease' : deps.isShuttingDown() ? 'shutdown' : 'exit' });

    if (leaseLost) return;
    if (sourceChanged) {
      await releaseJob(job.id, job.lease_id, { delaySec: 0, resetAttempts: true });
      return;
    }
    // Source ended or ffmpeg failed: hand back to the queue. If the stream
    // really went offline the control plane marks the job finished; otherwise
    // the next attempt (maybe on another worker) resumes the broadcast.
    const ranLong = result.ranMs > 60_000;
    await releaseJob(job.id, job.lease_id, {
      delaySec: deps.isShuttingDown() ? 0 : ranLong ? 1 : backoffSec(job.attempts),
      error: result.code === 0 ? undefined : redact(result.stderrTail).slice(-1000),
      resetAttempts: ranLong || deps.isShuttingDown(),
    });
  } catch (err) {
    const message = redact((err as Error).message);
    log.warn({ err: message }, 'job attempt failed');
    if (!leaseLost) {
      await releaseJob(job.id, job.lease_id, { delaySec: backoffSec(job.attempts), error: message.slice(-1000), resetAttempts: false })
        .catch((e: unknown) => log.error({ err: (e as Error).message }, 'release failed'));
    }
  } finally {
    clearInterval(hb);
    clearInterval(watch);
    clearInterval(vodTimer);
    clearInterval(restreamTimer);
    restream?.stop();
    output?.abort();
    deps.shutdown.removeEventListener('abort', onShutdown);
    if (token) deps.receiver.unregister(token);
    metrics.activeJobs.dec();
  }
}
