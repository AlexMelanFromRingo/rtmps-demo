// Transcode job queue on Postgres: SKIP LOCKED claiming + time-bounded leases.
import pg from 'pg';
import { config } from '../config.ts';
import { one, pool, query } from '../lib/db.ts';
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
};

export type JobContext = {
  broadcast_status: string;
  broadcast_started_at: Date;
  channel_id: string;
  transcode_mode: TranscodeMode;
};

export const JOBS_CHANNEL = 'transcode_jobs';

/**
 * Claims the oldest runnable job. With minWaitSec > 0 only jobs that have
 * already waited that long are taken (used for degraded, low-cost claims).
 */
export async function claimJob(workerId: string, leaseSec: number, minWaitSec = 0): Promise<JobRow | null> {
  return one<JobRow>(`
    WITH next AS (
      SELECT id FROM transcode_jobs
      WHERE ((state = 'pending' AND not_before <= now() - make_interval(secs => $3)
                                AND updated_at <= now() - make_interval(secs => $3))
          OR (state = 'running' AND lease_expires_at < now() - make_interval(secs => $3)))
      ORDER BY created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE transcode_jobs j
       SET state = 'running', worker_id = $1, attempts = j.attempts + 1,
           lease_expires_at = now() + make_interval(secs => $2), updated_at = now()
      FROM next WHERE j.id = next.id
    RETURNING j.id, j.broadcast_id, j.source_id, j.source_url, j.source_srt_url, j.attempts`, [workerId, leaseSec, minWaitSec]);
}

/**
 * A restarted container keeps its hostname (and PID 1), hence its worker id.
 * Jobs still leased to that id belong to our previous, crashed incarnation:
 * hand them back right away instead of waiting for the lease to expire.
 */
export async function releaseOrphanedJobs(workerId: string): Promise<number> {
  const rows = await query(`UPDATE transcode_jobs SET state = 'pending', worker_id = NULL, lease_expires_at = NULL,
                              not_before = now(), updated_at = now()
                             WHERE worker_id = $1 AND state = 'running' RETURNING id`, [workerId]);
  if (rows.length > 0) await query('NOTIFY transcode_jobs');
  return rows.length;
}

export async function loadJobContext(jobId: string): Promise<JobContext | null> {
  return one<JobContext>(`
    SELECT b.status AS broadcast_status, b.started_at AS broadcast_started_at,
           c.id::text AS channel_id, c.transcode_mode
      FROM transcode_jobs j
      JOIN broadcasts b ON b.id = j.broadcast_id
      JOIN channels c ON c.id = b.channel_id
     WHERE j.id = $1`, [jobId]);
}

/** Extends the lease. Returns false if the job is no longer ours (cancelled/finished/stolen). */
export async function heartbeat(jobId: string, workerId: string, leaseSec: number, stats: unknown): Promise<boolean> {
  const row = await one(`
    UPDATE transcode_jobs SET lease_expires_at = now() + make_interval(secs => $3), stats = $4, updated_at = now()
     WHERE id = $1 AND worker_id = $2 AND state = 'running'
    RETURNING id`, [jobId, workerId, leaseSec, JSON.stringify(stats)]);
  return row !== null;
}

/** Give the job back to the queue (retry with backoff, possibly on another worker). */
export async function releaseJob(jobId: string, workerId: string, opts: { delaySec: number; error?: string | undefined; resetAttempts: boolean }): Promise<void> {
  await query(`
    UPDATE transcode_jobs
       SET state = CASE WHEN NOT $5 AND attempts >= $6 THEN 'failed' ELSE 'pending' END,
           worker_id = NULL, lease_expires_at = NULL,
           not_before = now() + make_interval(secs => $3),
           last_error = COALESCE($4, last_error),
           attempts = CASE WHEN $5 THEN 0 ELSE attempts END,
           updated_at = now()
     WHERE id = $1 AND worker_id = $2 AND state = 'running'`,
  [jobId, workerId, opts.delaySec, opts.error ?? null, opts.resetAttempts, config.control.maxJobAttempts]);
}

export async function setJobState(jobId: string, workerId: string, state: 'finished' | 'failed' | 'cancelled', error?: string): Promise<void> {
  await query(`UPDATE transcode_jobs SET state = $3, last_error = COALESCE($4, last_error), lease_expires_at = NULL, updated_at = now()
                WHERE id = $1 AND worker_id = $2 AND state = 'running'`, [jobId, workerId, state, error ?? null]);
}

export async function updateBroadcastSource(broadcastId: string, src: ProbedSource): Promise<void> {
  await query(`UPDATE broadcasts SET video_codec = $2, audio_codec = $3, width = $4, height = $5, fps = $6
                WHERE id = $1`, [broadcastId, src.videoCodec, src.audioCodec ?? null, src.width, src.height, src.fps]);
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
  const connect = async () => {
    if (signal.aborted) return;
    const client = new pg.Client({ connectionString: config.databaseUrl, application_name: 'streamhub-worker-listen' });
    const retry = () => {
      client.end().catch(() => {});
      if (!signal.aborted) setTimeout(() => void connect(), 2000);
    };
    client.on('error', (err) => { log.warn({ err: err.message }, 'job listener connection lost'); retry(); });
    client.on('notification', () => onNotify());
    try {
      await client.connect();
      await client.query(`LISTEN ${JOBS_CHANNEL}`);
      signal.addEventListener('abort', () => void client.end().catch(() => {}), { once: true });
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'job listener connect failed');
      retry();
    }
  };
  void connect();
}

export { pool };
