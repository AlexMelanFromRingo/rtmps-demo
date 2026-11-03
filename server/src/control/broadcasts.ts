// Broadcast lifecycle — the single place where "who is live" changes.
// Every function here is idempotent and safe to call concurrently from hooks
// (edge-triggered) and the reconciler (level-triggered).
import type pg from 'pg';
import { config, INGEST_READ_USER } from '../config.ts';
import { safeEqual } from '../lib/crypto.ts';
import { one, query, tx } from '../lib/db.ts';
import { publishChannelEvent } from '../lib/events.ts';
import { log } from '../lib/log.ts';

export const INGEST_APP = 'live';

import { protocolFromSourceType, streamKeyFromPath } from './paths.ts';

export { protocolFromSourceType, streamKeyFromPath };

// ── MediaMTX authentication hook ────────────────────────────────────────────
export type AuthRequest = {
  user?: string; password?: string; token?: string; ip?: string;
  action?: string; path?: string; protocol?: string; id?: string | null; query?: string;
};

export type AuthDecision = { allow: boolean; reason: string };

export async function authorizeIngest(req: AuthRequest): Promise<AuthDecision> {
  switch (req.action) {
    case 'publish': {
      const key = streamKeyFromPath(req.path ?? '');
      if (!key) return { allow: false, reason: 'bad path' };
      const ch = await one<{ id: string }>('SELECT id FROM channels WHERE stream_key = $1', [key]);
      return ch ? { allow: true, reason: 'stream key ok' } : { allow: false, reason: 'unknown stream key' };
    }
    case 'read': {
      // Only transcoders may read raw ingest streams; viewers use the CDN.
      const ok = req.user === INGEST_READ_USER && !!req.password && safeEqual(req.password, config.internalSecret);
      return { allow: ok, reason: ok ? 'internal reader' : 'readers must authenticate' };
    }
    default:
      return { allow: false, reason: `action ${req.action ?? '?'} not allowed` };
  }
}

// ── node registry ───────────────────────────────────────────────────────────
export type IngestNode = { id: string; api_url: string; rtsp_url: string; srt_url: string; last_seen_at: Date };

export async function registerNode(id: string, apiUrl: string, rtspUrl: string, srtUrl: string): Promise<void> {
  const trim = (u: string) => u.replace(/\/$/, '');
  await query(`INSERT INTO ingest_nodes (id, api_url, rtsp_url, srt_url, last_seen_at) VALUES ($1, $2, $3, $4, now())
               ON CONFLICT (id) DO UPDATE SET api_url = EXCLUDED.api_url, rtsp_url = EXCLUDED.rtsp_url,
                 srt_url = EXCLUDED.srt_url, last_seen_at = now()`,
  [id, trim(apiUrl), trim(rtspUrl), trim(srtUrl)]);
}

export async function getNode(id: string): Promise<IngestNode | null> {
  return one<IngestNode>('SELECT * FROM ingest_nodes WHERE id = $1', [id]);
}

// ── online / offline ────────────────────────────────────────────────────────
export type StreamEvent = { node: string; path: string; sourceType?: string | undefined; sourceId: string; query?: string | undefined };

type ActiveBroadcast = { id: string; status: string; source_id: string | null; ingest_node: string | null; ingest_path: string | null };
type LockedChannel = { id: string; title: string; category: string };

/**
 * Resolves and locks the channel an ingest path belongs to. An active
 * broadcast already bound to this path wins (its key may have been reset
 * mid-stream); otherwise the channel whose *current* key matches.
 * The channel row lock serialises every lifecycle change of that channel.
 */
async function lockChannelForPath(c: pg.PoolClient, path: string, key: string): Promise<LockedChannel | null> {
  const owner = await one<{ id: string }>(`
    SELECT channel_id::text AS id FROM broadcasts WHERE ingest_path = $1 AND status <> 'ended'
    UNION ALL
    SELECT id::text FROM channels WHERE stream_key = $2
    LIMIT 1`, [path, key], c);
  if (!owner) return null;
  return one<LockedChannel>('SELECT id::text, title, category FROM channels WHERE id = $1 FOR UPDATE', [owner.id], c);
}

/** Stream became available on an ingest node. Returns the broadcast id. */
export async function handleOnline(ev: StreamEvent, extra?: { videoCodec?: string | null; audioCodec?: string | null; width?: number | null; height?: number | null }): Promise<string | null> {
  const key = streamKeyFromPath(ev.path);
  if (!key) return null;
  const node = await getNode(ev.node);
  if (!node) throw new Error(`unknown ingest node ${ev.node}`); // hook retries after node heartbeat
  const sourceUrl = `${node.rtsp_url}/${ev.path}`;
  const sourceSrtUrl = node.srt_url;
  const protocol = protocolFromSourceType(ev.sourceType, ev.query);

  const result = await tx(async (c) => {
    const ch = await lockChannelForPath(c, ev.path, key);
    if (!ch) return null;
    let b = await one<ActiveBroadcast>(
      `SELECT id, status, source_id, ingest_node, ingest_path FROM broadcasts
        WHERE channel_id = $1 AND status <> 'ended' FOR UPDATE`, [ch.id], c);

    if (b && b.status === 'live' && b.source_id === ev.sourceId) {
      // duplicate notification — just make sure a job exists
    } else if (b) {
      // Reconnect within the grace period, or takeover by a newer publisher.
      await query(`UPDATE broadcasts SET status = 'live', offline_since = NULL, ingest_node = $2, source_id = $3,
                     source_url = $4, protocol = $5, source_srt_url = $10, ingest_path = $11,
                     video_codec = COALESCE($6, video_codec), audio_codec = COALESCE($7, audio_codec),
                     width = COALESCE($8, width), height = COALESCE($9, height)
                   WHERE id = $1 AND status <> 'ended'`,
      [b.id, ev.node, ev.sourceId, sourceUrl, protocol, extra?.videoCodec ?? null, extra?.audioCodec ?? null,
        extra?.width ?? null, extra?.height ?? null, sourceSrtUrl, ev.path], c);
    } else {
      b = (await one<ActiveBroadcast>(
        `INSERT INTO broadcasts (channel_id, status, title, category, ingest_node, source_id, source_url, protocol,
                                 video_codec, audio_codec, width, height, source_srt_url, ingest_path)
         VALUES ($1, 'live', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING id, status, source_id, ingest_node, ingest_path`,
        [ch.id, ch.title, ch.category, ev.node, ev.sourceId, sourceUrl, protocol,
          extra?.videoCodec ?? null, extra?.audioCodec ?? null, extra?.width ?? null, extra?.height ?? null, sourceSrtUrl, ev.path], c))!;
    }

    // Exactly one active job, bound to the current ingest connection.
    await query(`UPDATE transcode_jobs SET state = 'cancelled', lease_id = NULL, updated_at = now()
                  WHERE broadcast_id = $1 AND state IN ('pending', 'running') AND source_id <> $2`, [b.id, ev.sourceId], c);
    const inserted = await query(`INSERT INTO transcode_jobs (broadcast_id, source_id, source_url, source_srt_url) VALUES ($1, $2, $3, $4)
                  ON CONFLICT (broadcast_id) WHERE state IN ('pending', 'running') DO NOTHING RETURNING id`,
    [b.id, ev.sourceId, sourceUrl, sourceSrtUrl], c);
    if (inserted.length > 0) await c.query(`NOTIFY transcode_jobs`);
    return { broadcastId: b.id, channelId: ch.id, newJob: inserted.length > 0 };
  });

  if (!result) return null;
  log.info({ node: ev.node, sourceType: ev.sourceType, sourceId: ev.sourceId, broadcast: result.broadcastId, newJob: result.newJob }, 'stream online');
  await publishChannelEvent(result.channelId, { kind: 'state' });
  return result.broadcastId;
}

/** Stream disappeared from its ingest node → enter the reconnect grace period. */
export async function handleOffline(ev: StreamEvent): Promise<void> {
  const key = streamKeyFromPath(ev.path);
  if (!key) return;
  const result = await tx(async (c) => {
    const ch = await lockChannelForPath(c, ev.path, key);
    if (!ch) return null;
    const b = await one<ActiveBroadcast>(
      `SELECT id, status, source_id, ingest_node, ingest_path FROM broadcasts
        WHERE channel_id = $1 AND status = 'live' FOR UPDATE`, [ch.id], c);
    // Ignore stale events: a newer publisher may already own the broadcast.
    if (!b || b.source_id !== ev.sourceId) return null;
    await query(`UPDATE broadcasts SET status = 'reconnecting', offline_since = now(), ingest_kbps = NULL WHERE id = $1`, [b.id], c);
    await query(`UPDATE transcode_jobs SET state = 'finished', lease_id = NULL, lease_expires_at = NULL, updated_at = now()
                  WHERE broadcast_id = $1 AND state IN ('pending', 'running')`, [b.id], c);
    return { broadcastId: b.id, channelId: ch.id };
  });
  if (!result) return;
  log.info({ node: ev.node, sourceId: ev.sourceId, broadcast: result.broadcastId }, 'stream offline (grace period started)');
  await publishChannelEvent(result.channelId, { kind: 'state' });
}

/**
 * Close broadcasts whose publisher did not come back within the grace period.
 * Each close takes the channel lock, so it serialises with a reconnect that
 * races the deadline (the reconnect either wins or starts a fresh broadcast).
 */
export async function finalizeExpired(): Promise<number> {
  const due = await query<{ id: string; channel_id: string }>(`
    SELECT id, channel_id::text FROM broadcasts
     WHERE status = 'reconnecting' AND offline_since < now() - make_interval(secs => $1)`, [config.control.reconnectGraceSec]);
  let ended = 0;
  for (const d of due) {
    const closed = await tx(async (c) => {
      await c.query('SELECT 1 FROM channels WHERE id = $1 FOR UPDATE', [d.channel_id]);
      const rows = await query(`UPDATE broadcasts SET status = 'ended', ended_at = offline_since
                                 WHERE id = $1 AND status = 'reconnecting'
                                   AND offline_since < now() - make_interval(secs => $2) RETURNING id`,
      [d.id, config.control.reconnectGraceSec], c);
      if (rows.length === 0) return false; // the publisher came back just in time
      await query(`UPDATE transcode_jobs SET state = 'cancelled', lease_id = NULL, updated_at = now()
                    WHERE broadcast_id = $1 AND state IN ('pending', 'running')`, [d.id], c);
      return true;
    });
    if (!closed) continue;
    ended++;
    log.info({ broadcast: d.id }, 'broadcast ended');
    await publishChannelEvent(d.channel_id, { kind: 'state' });
  }
  return ended;
}
