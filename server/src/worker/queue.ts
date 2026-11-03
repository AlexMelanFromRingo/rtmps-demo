// Transcode job queue on Postgres: SKIP LOCKED claiming + time-bounded leases.
import pg from 'pg';
import { config } from '../config.ts';
import { connectionOptions, one, pool, query } from '../lib/db.ts';
import { log } from '../lib/log.ts';
import type { ProbedSource, TranscodeMode, Variant } from './ladder.ts';
import type { ObservedBitrates } from './master.ts';

export type JobRow = {
  id: string;
  broadcast_id: string;
  source_id: string;
  source_url: string;
  source_srt_url: string | null;
  attempts: number;
  /** Token of THIS claim. Every later write is fenced on it. */
  lease_id: string;
};

export type JobContext = {
  broadcast_status: string;
  broadcast_started_at: Date;
  channel_id: string;
  transcode_mode: TranscodeMode;
  low_latency: boolean;
  vod_enabled: boolean;
};

export const JOBS_CHANNEL = 'transcode_jobs';

/**
 * Claims the oldest runnable job and issues a fresh lease token. With
 * minWaitSec > 0 only jobs that have already waited that long are taken
 * (degraded, low-cost claims). Jobs this process is already running are
 * never re-claimed, even if their lease lapsed during a DB outage.
 */
export async function claimJob(workerId: string, leaseSec: number, minWaitSec = 0, runningIds: string[] = []): Promise<JobRow | null> {
  return one<JobRow>(`
    WITH next AS (
      SELECT id FROM transcode_jobs
      WHERE ((state = 'pending' AND not_before <= now() - make_interval(secs => $3)
                                AND updated_at <= now() - make_interval(secs => $3))
          OR (state = 'running' AND lease_expires_at < now() - make_interval(secs => $3)))
        AND id <> ALL($4::uuid[])
      ORDER BY created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE transcode_jobs j
       SET state = 'running', worker_id = $1, attempts = j.attempts + 1, lease_id = gen_random_uuid(),
           lease_expires_at = now() + make_interval(secs => $2), updated_at = now()
      FROM next WHERE j.id = next.id
    RETURNING j.id, j.broadcast_id, j.source_id, j.source_url, j.source_srt_url, j.attempts, j.lease_id`,
  [workerId, leaseSec, minWaitSec, runningIds]);
}

/**
 * A restarted container keeps its hostname (and PID 1), hence its worker id.
 * Jobs still leased to that id belong to our previous, crashed incarnation:
 * hand them back right away instead of waiting for the lease to expire.
 */
export async function releaseOrphanedJobs(workerId: string): Promise<number> {
  const rows = await query(`UPDATE transcode_jobs SET state = 'pending', worker_id = NULL, lease_id = NULL, lease_expires_at = NULL,
                              not_before = now(), updated_at = now()
                             WHERE worker_id = $1 AND state = 'running' RETURNING id`, [workerId]);
  if (rows.length > 0) await query('NOTIFY transcode_jobs');
  return rows.length;
}

export async function loadJobContext(jobId: string): Promise<JobContext | null> {
  return one<JobContext>(`
    SELECT b.status AS broadcast_status, b.started_at AS broadcast_started_at,
           c.id::text AS channel_id, c.transcode_mode, c.low_latency, b.vod_enabled
      FROM transcode_jobs j
      JOIN broadcasts b ON b.id = j.broadcast_id
      JOIN channels c ON c.id = b.channel_id
     WHERE j.id = $1`, [jobId]);
}

/** Extends the lease. Returns false if this claim no longer owns the job (cancelled/finished/re-claimed). */
export async function heartbeat(jobId: string, leaseId: string, leaseSec: number, stats: unknown): Promise<boolean> {
  const row = await one(`
    UPDATE transcode_jobs SET lease_expires_at = now() + make_interval(secs => $3), stats = $4, updated_at = now()
     WHERE id = $1 AND lease_id = $2 AND state = 'running'
    RETURNING id`, [jobId, leaseId, leaseSec, JSON.stringify(stats)]);
  return row !== null;
}

/** Give the job back to the queue (retry with backoff, possibly on another worker). */
export async function releaseJob(jobId: string, leaseId: string, opts: { delaySec: number; error?: string | undefined; resetAttempts: boolean }): Promise<void> {
  await query(`
    UPDATE transcode_jobs
       SET state = CASE WHEN NOT $5 AND attempts >= $6 THEN 'failed' ELSE 'pending' END,
           worker_id = NULL, lease_id = NULL, lease_expires_at = NULL,
           not_before = now() + make_interval(secs => $3),
           last_error = COALESCE($4, last_error),
           attempts = CASE WHEN $5 THEN 0 ELSE attempts END,
           updated_at = now()
     WHERE id = $1 AND lease_id = $2 AND state = 'running'`,
  [jobId, leaseId, opts.delaySec, opts.error ?? null, opts.resetAttempts, config.control.maxJobAttempts]);
}

export async function setJobState(jobId: string, leaseId: string, state: 'finished' | 'failed' | 'cancelled', error?: string): Promise<void> {
  await query(`UPDATE transcode_jobs SET state = $3, last_error = COALESCE($4, last_error), lease_id = NULL, lease_expires_at = NULL, updated_at = now()
                WHERE id = $1 AND lease_id = $2 AND state = 'running'`, [jobId, leaseId, state, error ?? null]);
}

export async function updateBroadcastSource(broadcastId: string, src: ProbedSource, latencyMode: 'normal' | 'low'): Promise<void> {
  await query(`UPDATE broadcasts SET video_codec = $2, audio_codec = $3, width = $4, height = $5, fps = $6, latency_mode = $7
                WHERE id = $1`, [broadcastId, src.videoCodec, src.audioCodec ?? null, src.width, src.height, src.fps, latencyMode]);
}

export async function markBroadcastReady(broadcastId: string, variants: Variant[], observed: ObservedBitrates): Promise<void> {
  const renditions = variants.map((v) => ({
    name: v.name, label: v.label, codec: v.codec, width: v.width, height: v.height, fps: v.fps,
    bitrateKbps: v.kind === 'copy' && observed[v.name] ? Math.round(observed[v.name]!) : v.bitrateKbps,
    passthrough: v.kind === 'copy',
  }));
  await query(`UPDATE broadcasts SET renditions = $2, ready_at = COALESCE(ready_at, now()) WHERE id = $1 AND status <> 'ended'`,
    [broadcastId, JSON.stringify(renditions)]);
}

/** LISTEN for new-job notifications on a dedicated connection (auto-reconnects). */
export function listenForJobs(onNotify: () => void, signal: AbortSignal): void {
  let current: pg.Client | null = null;
  signal.addEventListener('abort', () => void current?.end().catch(() => {}), { once: true });

  const connect = async () => {
    if (signal.aborted) return;
    const client = new pg.Client({ ...connectionOptions, query_timeout: undefined, application_name: 'streamhub-worker-listen' });
    current = client;
    let retried = false;
    const retry = (why: string) => {
      if (retried) return; // 'error' and a failed connect/LISTEN may both fire
      retried = true;
      log.warn({ err: why }, 'job listener connection lost — reconnecting');
      client.end().catch(() => {});
      if (!signal.aborted) setTimeout(() => void connect(), 2000);
    };
    client.on('error', (err) => retry(err.message));
    client.on('end', () => { if (!signal.aborted) retry('connection ended'); });
    client.on('notification', () => onNotify());
    try {
      await client.connect();
      await client.query(`LISTEN ${JOBS_CHANNEL}`);
    } catch (err) {
      retry((err as Error).message);
    }
  };
  void connect();
}

export { pool };
