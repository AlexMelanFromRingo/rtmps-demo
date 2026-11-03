// Transcoding worker: claims jobs from Postgres, runs ffmpeg, publishes HLS
// to object storage. Stateless and horizontally scalable — run as many as
// you have CPU/GPU for. Graceful SIGTERM hands running jobs back instantly.
import http from 'node:http';
import { config } from '../config.ts';
import { pool } from '../lib/db.ts';
import { log } from '../lib/log.ts';
import { redis } from '../lib/redis.ts';
import { ensureBucket } from '../lib/s3.ts';
import { installSignalHandlers, isShuttingDown, onShutdown, sleep } from '../lib/shutdown.ts';
import { detectEncoder } from './ffmpeg.ts';
import { metrics, registry } from './metrics.ts';
import { claimJob, listenForJobs, releaseOrphanedJobs } from './queue.ts';
import { SegmentReceiver } from './receiver.ts';
import { runJob } from './runner.ts';

process.env.SERVICE_NAME ??= 'worker';
installSignalHandlers(30_000);

const stop = new AbortController();
const running = new Map<Promise<void>, { degraded: boolean }>();
let wake: (() => void) | null = null;
const poke = () => { wake?.(); };

async function waitForStorage(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await ensureBucket();
      return;
    } catch (err) {
      if (stop.signal.aborted) return;
      log.warn({ err: (err as Error).message, attempt }, 'object storage not ready, retrying');
      await sleep(Math.min(5000, attempt * 1000), stop.signal);
    }
  }
}

async function main(): Promise<void> {
  const receiver = new SegmentReceiver();
  await receiver.start();

  const encoder = await detectEncoder(config.worker.ffmpegPath, config.worker.encoder);
  metrics.slots.set(config.worker.slots);
  log.info({ worker: config.worker.id, slots: config.worker.slots, encoder }, 'worker starting');

  // Health + metrics endpoint.
  const ops = http.createServer(async (req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(isShuttingDown() ? 503 : 200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok: !isShuttingDown(), active: running.size, slots: config.worker.slots }));
    } else if (req.url === '/metrics') {
      res.writeHead(200, { 'content-type': registry.contentType }).end(await registry.metrics());
    } else {
      res.writeHead(404).end();
    }
  });
  ops.listen(config.worker.metricsPort, '0.0.0.0');

  // Shutdown order (reverse of registration): stop claiming + abort jobs →
  // wait for them to hand their jobs back → close receiver/pools.
  onShutdown(async () => { await pool.end().catch(() => {}); redis.disconnect(); });
  onShutdown(async () => { ops.close(); await receiver.stop(); });
  onShutdown(async () => {
    stop.abort();
    poke();
    await Promise.allSettled([...running.keys()]);
    log.info('all jobs handed back');
  });

  await waitForStorage();
  const orphans = await releaseOrphanedJobs(config.worker.id);
  if (orphans > 0) log.warn({ orphans }, 'released jobs left over by a previous crash of this worker');
  listenForJobs(poke, stop.signal);

  while (!stop.signal.aborted) {
    const full = [...running.values()].filter((r) => !r.degraded).length;
    const canFull = full < config.worker.slots;
    const canDegraded = running.size < config.worker.slots + config.worker.remuxSlots;
    if (canFull || canDegraded) {
      let job = null;
      const degraded = !canFull;
      try {
        job = await claimJob(config.worker.id, config.worker.leaseSec, degraded ? config.worker.degradeAfterSec : 0);
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'claim failed');
      }
      if (job && !stop.signal.aborted) {
        metrics.claims.inc();
        log.info({ job: job.id, broadcast: job.broadcast_id, attempt: job.attempts, degraded }, 'job claimed');
        const p: Promise<void> = runJob(job, { receiver, encoder, isShuttingDown, shutdown: stop.signal, degraded })
          .catch((err: unknown) => log.error({ err }, 'job crashed'))
          .finally(() => { running.delete(p); poke(); });
        running.set(p, { degraded });
        continue; // try to fill remaining slots immediately
      }
    }
    // Sleep until a NOTIFY, a slot frees up, or the poll interval (expired leases).
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 2000);
      wake = () => { clearTimeout(t); wake = null; resolve(); };
    });
  }
}

main().catch((err) => {
  log.fatal({ err }, 'worker crashed');
  process.exit(1);
});
