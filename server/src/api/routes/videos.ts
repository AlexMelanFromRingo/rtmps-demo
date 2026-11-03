// Recordings of past broadcasts (VOD).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.ts';
import { one, query } from '../../lib/db.ts';
import { HttpError, notFound } from '../../lib/errors.ts';
import { keys, redis } from '../../lib/redis.ts';
import { rateLimit } from '../ratelimit.ts';
import { requireUser } from '../session.ts';
import { CHANNEL_COLS, channelBySlug, channelPublic, hlsUrl, type ChannelRow, type Rendition } from '../views.ts';

type VideoRow = ChannelRow & {
  vid: string; vtitle: string; vcategory: string; started_at: Date; ended_at: Date;
  vod_duration_sec: number | null; views: number; renditions: Rendition[];
};

// A broadcast is a watchable video once its VOD playlists are finalized.
const PLAYABLE = `b.status = 'ended' AND b.vod_enabled AND NOT b.vod_deleted AND NOT b.storage_purged
  AND b.vod_finalized_at IS NOT NULL AND b.ready_at IS NOT NULL`;

const VIDEO_SELECT = `SELECT b.id AS vid, b.title AS vtitle, b.category AS vcategory, b.started_at, b.ended_at,
    b.vod_duration_sec, b.views, b.renditions, ${CHANNEL_COLS}
  FROM broadcasts b JOIN channels c ON c.id = b.channel_id JOIN users u ON u.id = c.owner_id`;

function videoView(r: VideoRow) {
  const ended = new Date(r.ended_at);
  return {
    id: r.vid,
    channel: channelPublic(r),
    title: r.vtitle,
    category: r.vcategory,
    startedAt: new Date(r.started_at).toISOString(),
    endedAt: ended.toISOString(),
    durationSec: Math.round(r.vod_duration_sec ?? (ended.getTime() - new Date(r.started_at).getTime()) / 1000),
    thumbnailUrl: hlsUrl(r.vid, 'thumb.jpg'),
    playbackUrl: hlsUrl(r.vid, 'vod.m3u8'),
    views: r.views,
    expiresAt: new Date(ended.getTime() + config.control.vodRetentionDays * 86_400_000).toISOString(),
    renditions: r.renditions,
  };
}

const idParams = z.object({ id: z.uuid() });
const slugParams = z.object({ slug: z.string().min(1).max(25) });

export async function videoRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/channels/:slug/videos', async (req, reply) => {
    const { slug } = slugParams.parse(req.params);
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }).parse(req.query);
    const ch = await channelBySlug(slug);
    if (!ch) throw notFound('Канал не найден');
    reply.header('cache-control', 'public, max-age=5');
    const rows = await query<VideoRow>(`${VIDEO_SELECT} WHERE b.channel_id = $1 AND ${PLAYABLE}
                                         ORDER BY b.started_at DESC LIMIT $2`, [ch.id, limit]);
    return { videos: rows.map(videoView) };
  });

  app.get('/api/videos/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    const row = await one<VideoRow>(`${VIDEO_SELECT} WHERE b.id = $1 AND ${PLAYABLE}`, [id]);
    if (!row) throw notFound('Запись не найдена или уже удалена');
    return { video: videoView(row) };
  });

  app.post('/api/videos/:id/view', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const { viewerId } = z.object({ viewerId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/) }).parse(req.body);
    await rateLimit('vod-view', req.ip, 120, 60);
    // One view per viewer per 6 hours (Redis); without Redis count every call.
    const fresh = redis.status === 'ready'
      ? await redis.set(keys.videoView(id, viewerId), '1', 'EX', 6 * 3600, 'NX').catch(() => 'OK')
      : 'OK';
    if (fresh === 'OK') await query(`UPDATE broadcasts b SET views = views + 1 WHERE id = $1 AND ${PLAYABLE}`, [id]);
    return reply.status(204).send();
  });

  app.delete('/api/videos/:id', async (req, reply) => {
    const user = await requireUser(req);
    const { id } = idParams.parse(req.params);
    const row = await one<{ channel_id: string }>('SELECT channel_id::text FROM broadcasts WHERE id = $1 AND status = \'ended\'', [id]);
    if (!row) throw notFound('Запись не найдена');
    if (row.channel_id !== user.channel_id) throw new HttpError(403, 'forbidden', 'Это не ваша запись');
    // Media is purged by the control loop's housekeeping shortly after.
    await query('UPDATE broadcasts SET vod_deleted = true WHERE id = $1', [id]);
    return reply.status(204).send();
  });
}

