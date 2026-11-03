// Executes one claimed transcode job end-to-end:
// probe source → plan ladder → run ffmpeg → publish HLS → keep lease alive.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import { publishChannelEvent } from '../lib/events.ts';
import { log as rootLog } from '../lib/log.ts';
import { objectKeys, putObject, s3 } from '../lib/s3.ts';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { buildTranscodeArgs, choosePullUrl, parseProgress, probeSource, type Encoder, type Progress } from './ffmpeg.ts';
import { parseRungs, planLadder, sourceUpgraded } from './ladder.ts';
import { JobOutput } from './output.ts';
import type { SegmentReceiver } from './receiver.ts';
import {
  heartbeat, loadJobContext, markBroadcastReady, releaseJob, setJobState, updateBroadcastSource, type JobRow,
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

export function backoffSec(attempts: number): number {
  return Math.min(15, 2 ** Math.max(0, attempts - 1));
}

type FfmpegResult = { code: number | null; signal: NodeJS.Signals | null; stderrTail: string; ranMs: number };

function runFfmpeg(args: string[], signal: AbortSignal, onProgress: (p: Progress) => void): Promise<FfmpegResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(config.worker.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
  let progress: Progress = { fps: null, speed: null, outTimeSec: null };
  let output: JobOutput | null = null;
  let token: string | null = null;
  let renditionCount = 0;
  let sourceChanged = false;
  let watch: NodeJS.Timeout | undefined;

  // Lease keeper. Fencing: if we cannot renew for a whole lease period we
  // stop on our own, because another worker may already have taken over.
  let lastRenewed = Date.now();
  const hb = setInterval(() => {
    const stats = {
      fps: progress.fps, speed: progress.speed, encoder: deps.encoder, renditions: renditionCount, degraded: deps.degraded,
      uploads: output?.stats.uploads ?? 0, uploadFailures: output?.stats.failures ?? 0,
      pendingUploads: output?.stats.pending ?? 0, worker: workerId,
    };
    heartbeat(job.id, workerId, config.worker.leaseSec, stats).then((owned) => {
      lastRenewed = Date.now();
      if (!owned && !leaseLost) {
        log.info('job no longer owned (finished/cancelled/reassigned) — stopping');
        leaseLost = true;
        kill.abort();
      }
    }).catch((err: unknown) => {
      log.warn({ err: (err as Error).message }, 'lease heartbeat failed');
      if (Date.now() - lastRenewed > config.worker.leaseSec * 1000 && !leaseLost) {
        log.error('lease expired without renewal — fencing off');
        leaseLost = true;
        kill.abort();
      }
    });
    // Stall watchdog: no new media for a long time → restart the transcode.
    const last = output?.stats.lastSegmentAt;
    const stallMs = Math.max(20_000, config.worker.segmentSec * 8000);
    if (output && !kill.signal.aborted && Date.now() - (last ?? jobStarted) > stallMs) {
      log.warn({ stallMs }, 'no segments produced — restarting transcode');
      kill.abort();
    }
  }, config.worker.heartbeatSec * 1000);

  try {
    if (job.attempts > config.control.maxJobAttempts) {
      await setJobState(job.id, workerId, 'failed', 'too many attempts');
      return;
    }
    const ctx = await loadJobContext(job.id);
    if (!ctx || ctx.broadcast_status === 'ended') {
      await setJobState(job.id, workerId, 'cancelled');
      return;
    }

    const src = await probeSource(config.worker.ffprobePath, withReadCredentials(job.source_url));
    const sourceUrl = choosePullUrl(src, job.source_url, job.source_srt_url, config.worker.ingestReadUser, config.internalSecret);
    log.info({ src, transport: sourceUrl.slice(0, sourceUrl.indexOf(':')) }, 'source probed');
    await updateBroadcastSource(job.broadcast_id, src);
    await publishChannelEvent(ctx.channel_id, { kind: 'state' });

    const plan = planLadder(src, deps.degraded ? 'degraded' : ctx.transcode_mode, rungs);
    if (deps.degraded) log.warn('no transcoding capacity — serving the source only (degraded)');
    renditionCount = plan.variants.length;
    token = randomUUID();
    output = new JobOutput({
      prefix: objectKeys.prefix(job.broadcast_id),
      plan,
      log,
      put: async (key, body, contentType, cacheControl) => {
        const t = process.hrtime.bigint();
        await putObject(key, body, contentType, cacheControl);
        metrics.uploadSeconds.observe(Number(process.hrtime.bigint() - t) / 1e9);
      },
      del: async (key) => { await s3.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: key })); },
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
      segmentSec: config.worker.segmentSec,
      listSize: config.worker.listSize,
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

    const result = await runFfmpeg(args, kill.signal, (p) => { progress = p; });
    clearInterval(watch);
    await output.drain();
    log.info({ code: result.code, signal: result.signal, ranSec: Math.round(result.ranMs / 1000) }, 'ffmpeg exited');
    metrics.ffmpegExits.inc({ reason: leaseLost ? 'lease' : deps.isShuttingDown() ? 'shutdown' : 'exit' });

    if (leaseLost) return;
    if (sourceChanged) {
      await releaseJob(job.id, workerId, { delaySec: 0, resetAttempts: true });
      return;
    }
    // Source ended or ffmpeg failed: hand back to the queue. If the stream
    // really went offline the control plane marks the job finished; otherwise
    // the next attempt (maybe on another worker) resumes the broadcast.
    const ranLong = result.ranMs > 60_000;
    await releaseJob(job.id, workerId, {
      delaySec: deps.isShuttingDown() ? 0 : ranLong ? 1 : backoffSec(job.attempts),
      error: result.code === 0 ? undefined : result.stderrTail.slice(-1000),
      resetAttempts: ranLong || deps.isShuttingDown(),
    });
  } catch (err) {
    const message = (err as Error).message;
    log.warn({ err: message }, 'job attempt failed');
    if (!leaseLost) {
      await releaseJob(job.id, workerId, { delaySec: backoffSec(job.attempts), error: message.slice(-1000), resetAttempts: false })
        .catch((e: unknown) => log.error({ err: (e as Error).message }, 'release failed'));
    }
  } finally {
    clearInterval(hb);
    clearInterval(watch);
    deps.shutdown.removeEventListener('abort', onShutdown);
    if (token) deps.receiver.unregister(token);
    metrics.activeJobs.dec();
  }
}
