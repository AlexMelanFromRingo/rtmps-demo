// Executes one claimed transcode job end-to-end:
// probe source → plan ladder → run ffmpeg → publish HLS → keep lease alive.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import { publishChannelEvent } from '../lib/events.ts';
import { log as rootLog } from '../lib/log.ts';
import { redact } from '../lib/redact.ts';
import { deleteObject, objectKeys, putObject } from '../lib/s3.ts';
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

  // Lease keeper + fencing. A lease is renewed every heartbeatSec; the DB
  // sets its expiry to (renewal start + leaseSec) at the earliest. If we have
  // not renewed successfully for (leaseSec - heartbeatSec - 1) s we stop on our
  // own BEFORE the lease can be taken by another worker — also when the
  // renewal query hangs instead of failing.
  const fenceMs = Math.max(2000, (config.worker.leaseSec - config.worker.heartbeatSec - 1) * 1000);
  let lastRenewStart = Date.now();
  let renewing = false;
  const fenceOff = (why: string) => {
    if (leaseLost) return;
    log.warn({ why }, 'lost the job lease — stopping and discarding pending output');
    leaseLost = true;
    output?.abort(); // a fenced worker must not write anything else
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
      };
      heartbeat(job.id, job.lease_id, config.worker.leaseSec, stats).then((owned) => {
        if (owned) lastRenewStart = started;
        else fenceOff('job finished, cancelled or re-claimed');
      }).catch((err: unknown) => {
        log.warn({ err: (err as Error).message }, 'lease heartbeat failed');
      }).finally(() => { renewing = false; });
    }
    if (Date.now() - lastRenewStart > fenceMs) fenceOff('could not renew the lease in time');

    if (!output || kill.signal.aborted) return;
    // Stall watchdog: no new media from ffmpeg for a long time → restart.
    const stallMs = Math.max(20_000, config.worker.segmentSec * 8000);
    if (Date.now() - (output.stats.lastSegmentAt ?? jobStarted) > stallMs) {
      log.warn({ stallMs }, 'no segments produced — restarting transcode');
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
    if (leaseLost) output.abort();
    else await output.drain();
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
    output?.abort();
    deps.shutdown.removeEventListener('abort', onShutdown);
    if (token) deps.receiver.unregister(token);
    metrics.activeJobs.dec();
  }
}
