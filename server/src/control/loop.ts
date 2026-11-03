// Control loop, run by exactly one API replica at a time (leader election via
// a Postgres advisory lock). Level-triggered reconciliation makes the system
// converge even if hooks are lost, ingest nodes die or workers crash.
import pg from 'pg';
import { config } from '../config.ts';
import { connectionOptions, query } from '../lib/db.ts';
import { publishChannelEvent } from '../lib/events.ts';
import { log } from '../lib/log.ts';
import { keys, redis } from '../lib/redis.ts';
import { deletePrefix, objectKeys } from '../lib/s3.ts';
import { sleep } from '../lib/shutdown.ts';
import {
  finalizeExpired, handleOffline, handleOnline, streamKeyFromPath, type IngestNode,
} from './broadcasts.ts';

// ── MediaMTX control API ────────────────────────────────────────────────────
export type MtxPath = {
  name: string;
  online?: boolean;
  ready?: boolean;
  source?: { type: string; id: string } | null;
  tracks2?: { codec: string; codecProps?: { width?: number; height?: number } }[];
  inboundBytes?: number;
  bytesReceived?: number;
  readyTime?: string;
  onlineTime?: string;
};

export async function fetchPaths(apiUrl: string, timeoutMs = 2000): Promise<MtxPath[]> {
  const items: MtxPath[] = [];
  for (let page = 0; page < 50; page++) {
    const res = await fetch(`${apiUrl}/v3/paths/list?itemsPerPage=500&page=${page}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`ingest api ${res.status}`);
    const body = (await res.json()) as { items?: MtxPath[]; pageCount?: number };
    items.push(...(body.items ?? []));
    if (page + 1 >= (body.pageCount ?? 1)) break;
  }
  return items;
}

const TRACK_NAMES: Record<string, string> = { 'MPEG-4 Audio': 'AAC', 'MPEG-1/2 Audio': 'MP3' };
export function codecsFromTracks(tracks: MtxPath['tracks2']) {
  const video = tracks?.find((t) => ['H264', 'H265', 'AV1', 'VP9', 'VP8', 'MPEG-4 Video', 'MPEG-1/2 Video'].includes(t.codec));
  const audio = tracks?.find((t) => t !== video);
  return {
    videoCodec: video?.codec ?? null,
    audioCodec: audio ? (TRACK_NAMES[audio.codec] ?? audio.codec) : null,
    // MediaMTX reports 0 before it has parsed the first SPS: unknown, not zero.
    width: video?.codecProps?.width || null,
    height: video?.codecProps?.height || null,
  };
}

/** The most recently started source among duplicates of one path. */
function newest(seen: SeenSource[]): SeenSource | undefined {
  const t = (s: SeenSource) => Date.parse(s.item.onlineTime ?? s.item.readyTime ?? '') || 0;
  return [...seen].sort((a, b) => t(b) - t(a))[0];
}

// ── loop ────────────────────────────────────────────────────────────────────
type ActiveRow = {
  id: string; channel_id: string; status: string; source_id: string | null; ingest_node: string | null;
  ingest_path: string | null; ingest_kbps: number | null;
};

type SeenSource = { node: string; item: MtxPath };

export class ControlLoop {
  private readonly bytes = new Map<string, { bytes: number; at: number }>();
  private readonly nodeFailures = new Map<string, number>();
  private readonly lastViewers = new Map<string, number>();
  private lastSampleAt = 0;
  private lastHousekeepingAt = 0;

  async tick(): Promise<void> {
    await this.step('reconcile', () => this.reconcileIngest());
    await this.step('finalize', () => finalizeExpired());
    await this.step('jobs', () => this.healJobs());
    await this.step('viewers', () => this.countViewers());
    if (Date.now() - this.lastHousekeepingAt > 60_000) {
      this.lastHousekeepingAt = Date.now();
      await this.step('housekeeping', () => this.housekeeping());
    }
  }

  private async step(name: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      log.warn({ err: (err as Error).message, step: name }, 'control step failed');
    }
  }

  async reconcileIngest(): Promise<void> {
    // Snapshot broadcasts BEFORE querying nodes: anything that goes live in
    // between is simply not judged this round (prevents false "offline").
    const active = await query<ActiveRow>(`
      SELECT id, channel_id::text, status, source_id, ingest_node, ingest_path, ingest_kbps
        FROM broadcasts WHERE status <> 'ended'`);
    const nodes = await query<IngestNode>(`SELECT * FROM ingest_nodes WHERE last_seen_at > now() - interval '10 minutes'`);

    // Phase 1: observe every node.
    const responded = new Set<string>();
    const dead = new Set<string>();
    const byPath = new Map<string, SeenSource[]>();
    await Promise.all(nodes.map(async (node) => {
      try {
        const paths = await fetchPaths(node.api_url);
        this.nodeFailures.delete(node.id);
        responded.add(node.id);
        for (const p of paths) {
          if (!streamKeyFromPath(p.name) || !p.source || !(p.online ?? p.ready)) continue;
          const list = byPath.get(p.name) ?? [];
          list.push({ node: node.id, item: p });
          byPath.set(p.name, list);
        }
      } catch (err) {
        const n = (this.nodeFailures.get(node.id) ?? 0) + 1;
        this.nodeFailures.set(node.id, n);
        if (n === 1 || n % 10 === 0) log.warn({ node: node.id, err: (err as Error).message, failures: n }, 'ingest node unreachable');
        const silentFor = Date.now() - new Date(node.last_seen_at).getTime();
        if (silentFor > config.control.ingestNodeTimeoutSec * 1000 || n >= 8) dead.add(node.id);
      }
    }));
    const knownNodes = new Set(nodes.map((n) => n.id));

    // Phase 2: decide per broadcast. The current source keeps the broadcast as
    // long as ANY node still reports it — a stale duplicate on another node
    // (OBS reconnected elsewhere, two encoders on one key) never causes
    // flapping; the hooks deliver genuine takeovers.
    const handled = new Set<string>();
    for (const b of active) {
      if (b.status !== 'live' || !b.ingest_path || !b.source_id) continue;
      handled.add(b.ingest_path);
      const seen = byPath.get(b.ingest_path) ?? [];
      const current = seen.find((s) => s.item.source?.id === b.source_id);
      if (current) {
        await this.updateIngestBitrate(b, current.item.inboundBytes ?? current.item.bytesReceived ?? 0);
        continue;
      }
      const nodeGone = !b.ingest_node || !knownNodes.has(b.ingest_node) || dead.has(b.ingest_node);
      const nodeSaysGone = !!b.ingest_node && responded.has(b.ingest_node);
      if (!nodeGone && !nodeSaysGone) continue; // node unreachable but not yet dead: don't judge
      const replacement = newest(seen);
      if (replacement) {
        // Current source vanished, another node has the same path: take it over.
        await handleOnline({ node: replacement.node, path: b.ingest_path, sourceType: replacement.item.source!.type, sourceId: replacement.item.source!.id },
          codecsFromTracks(replacement.item.tracks2));
      } else {
        if (nodeGone && !nodeSaysGone) log.warn({ node: b.ingest_node, broadcast: b.id }, 'ingest node presumed dead — marking stream offline');
        await handleOffline({ node: b.ingest_node ?? 'unknown', path: b.ingest_path, sourceId: b.source_id });
      }
    }

    // Paths that are online but not attached to a live broadcast: missed
    // online hook, or a reconnect during the grace period.
    for (const [path, seen] of byPath) {
      if (handled.has(path)) continue;
      const pick = newest(seen)!;
      await handleOnline({ node: pick.node, path, sourceType: pick.item.source!.type, sourceId: pick.item.source!.id },
        codecsFromTracks(pick.item.tracks2));
    }
  }

  private async updateIngestBitrate(b: ActiveRow, bytes: number): Promise<void> {
    const now = Date.now();
    const prev = this.bytes.get(b.id);
    this.bytes.set(b.id, { bytes, at: now });
    if (!prev || bytes < prev.bytes || now - prev.at < 500) return;
    const kbps = Math.round(((bytes - prev.bytes) * 8) / (now - prev.at));
    if (b.ingest_kbps === null || Math.abs(kbps - b.ingest_kbps) > Math.max(50, b.ingest_kbps * 0.05)) {
      await query('UPDATE broadcasts SET ingest_kbps = $2 WHERE id = $1', [b.id, kbps]);
    }
  }

  /** Self-healing: a live broadcast must always have a job (retry failed ones after a cooldown). */
  async healJobs(): Promise<void> {
    const rows = await query<{ id: string }>(`
      INSERT INTO transcode_jobs (broadcast_id, source_id, source_url, source_srt_url)
      SELECT b.id, b.source_id, b.source_url, b.source_srt_url FROM broadcasts b
       WHERE b.status = 'live' AND b.source_id IS NOT NULL AND b.source_url IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM transcode_jobs j WHERE j.broadcast_id = b.id AND j.state IN ('pending', 'running'))
         AND NOT EXISTS (SELECT 1 FROM transcode_jobs j WHERE j.broadcast_id = b.id AND j.updated_at > now() - interval '30 seconds')
      ON CONFLICT DO NOTHING
      RETURNING id`);
    if (rows.length > 0) {
      log.warn({ jobs: rows.length }, 'recreated transcode jobs for live broadcasts');
      await query('NOTIFY transcode_jobs');
    }
    // Jobs of ended broadcasts must not keep running.
    await query(`UPDATE transcode_jobs j SET state = 'cancelled', updated_at = now() FROM broadcasts b
                  WHERE j.broadcast_id = b.id AND b.status = 'ended' AND j.state IN ('pending', 'running')`);
  }

  async countViewers(): Promise<void> {
    if (redis.status !== 'ready') return;
    const live = await query<{ id: string; channel_id: string }>(`SELECT id, channel_id::text FROM broadcasts WHERE status <> 'ended'`);
    const cutoff = Date.now() - config.control.viewerTtlSec * 1000;
    const pipe = redis.pipeline();
    for (const b of live) {
      pipe.zremrangebyscore(keys.viewers(b.id), '-inf', cutoff);
      pipe.zcard(keys.viewers(b.id));
    }
    const res = live.length > 0 ? ((await pipe.exec()) ?? []) : [];
    const counts = live.map((b, i) => ({ ...b, viewers: Number(res[i * 2 + 1]?.[1] ?? 0) }));

    const stale = (await redis.hkeys(keys.viewerCount)).filter((id) => !live.some((b) => b.id === id));
    const write = redis.multi();
    if (stale.length) write.hdel(keys.viewerCount, ...stale);
    for (const c of counts) write.hset(keys.viewerCount, c.id, c.viewers);
    if (counts.length || stale.length) await write.exec();

    for (const c of counts) {
      if (this.lastViewers.get(c.id) !== c.viewers) {
        this.lastViewers.set(c.id, c.viewers);
        await publishChannelEvent(c.channel_id, { kind: 'viewers', broadcastId: c.id, viewers: c.viewers });
      }
    }
    for (const id of [...this.lastViewers.keys()]) if (!live.some((b) => b.id === id)) this.lastViewers.delete(id);

    if (counts.length > 0) {
      await query(`UPDATE broadcasts b SET peak_viewers = GREATEST(b.peak_viewers, v.n)
                     FROM unnest($1::uuid[], $2::int[]) AS v(id, n) WHERE b.id = v.id AND v.n > b.peak_viewers`,
      [counts.map((c) => c.id), counts.map((c) => c.viewers)]);
      if (Date.now() - this.lastSampleAt > 30_000) {
        this.lastSampleAt = Date.now();
        await query(`INSERT INTO broadcast_samples (broadcast_id, viewers, ingest_kbps)
                     SELECT v.id, v.n, b.ingest_kbps FROM unnest($1::uuid[], $2::int[]) AS v(id, n)
                       JOIN broadcasts b ON b.id = v.id ON CONFLICT DO NOTHING`,
        [counts.map((c) => c.id), counts.map((c) => c.viewers)]);
      }
    }
  }

  async housekeeping(): Promise<void> {
    const ended = await query<{ id: string }>(`
      SELECT id FROM broadcasts WHERE status = 'ended' AND NOT storage_purged
         AND ended_at < now() - make_interval(mins => $1) ORDER BY ended_at LIMIT 25`, [config.control.retentionMinutes]);
    for (const b of ended) {
      const n = await deletePrefix(objectKeys.prefix(b.id));
      await query('UPDATE broadcasts SET storage_purged = true WHERE id = $1', [b.id]);
      log.info({ broadcast: b.id, objects: n }, 'purged broadcast media');
    }
    await query(`DELETE FROM auth_sessions WHERE expires_at < now()`);
    await query(`DELETE FROM ingest_nodes WHERE last_seen_at < now() - interval '1 day'`);
    await query(`DELETE FROM broadcast_samples WHERE ts < now() - interval '30 days'`);
    await query(`DELETE FROM transcode_jobs WHERE state IN ('finished', 'failed', 'cancelled') AND updated_at < now() - interval '7 days'`);
  }
}

// ── leader election ─────────────────────────────────────────────────────────
const LEADER_LOCK = 7_200_002;

/** Runs the control loop while holding a session-level advisory lock. */
export async function runControlLoopWhenLeader(signal: AbortSignal): Promise<void> {
  const loop = new ControlLoop();
  while (!signal.aborted) {
    // Keepalives on both ends + query timeout: if this host dies or is
    // partitioned, Postgres drops the session (releasing the advisory lock)
    // within seconds and another replica takes over.
    const client = new pg.Client({ ...connectionOptions, application_name: 'streamhub-leader' });
    let lost = false;
    client.on('error', (err) => { lost = true; log.warn({ err: err.message }, 'leader connection error'); });
    try {
      await client.connect();
      const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [LEADER_LOCK]);
      if (rows[0]?.ok) {
        log.info('acquired control-plane leadership');
        while (!signal.aborted && !lost) {
          const started = Date.now();
          await loop.tick();
          await client.query('SELECT 1'); // fail fast if our lock session died
          await sleep(Math.max(200, config.control.tickMs - (Date.now() - started)), signal);
        }
        log.info('released control-plane leadership');
      }
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'leader loop error');
    } finally {
      await client.end().catch(() => {});
    }
    await sleep(3000, signal);
  }
}
