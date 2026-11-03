// Community features: follows, "following" list, categories browse, search.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { one, query, tx } from '../../lib/db.ts';
import { HttpError, notFound } from '../../lib/errors.ts';
import { publishOverlayAlert } from '../../lib/events.ts';
import { keys, redis } from '../../lib/redis.ts';
import { rateLimit } from '../ratelimit.ts';
import { requireUser } from '../session.ts';
import {
  CHANNEL_COLS, channelBySlug, channelPublic, hlsUrl, liveByChannel, viewerCounts, type ChannelRow,
} from '../views.ts';

const slugParams = z.object({ slug: z.string().min(1).max(25) });
const searchQuery = z.object({ q: z.string().trim().min(2).max(60) });

/** Escape LIKE wildcards in user input. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

type Category = { name: string; liveCount: number; viewers: number; thumbnailUrl: string | null };

async function categories(filter?: string): Promise<Category[]> {
  const live = await query<{ k: string; name: string; ids: string[]; ready_ids: string[] }>(`
    SELECT lower(category) AS k, min(category) AS name, array_agg(id::text) AS ids,
           array_agg(id::text) FILTER (WHERE ready_at IS NOT NULL) AS ready_ids
      FROM broadcasts WHERE status <> 'ended' AND category <> ''
       AND (ready_at IS NOT NULL OR started_at > now() - interval '60 seconds')
       AND ($1::text IS NULL OR category ILIKE $1)
     GROUP BY 1`, [filter ? `%${likeEscape(filter)}%` : null]);
  const counts = await viewerCounts(live.flatMap((c) => c.ids));
  const out = new Map<string, Category>();
  for (const c of live) {
    const ids = c.ids;
    const top = [...(c.ready_ids ?? [])].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0))[0];
    out.set(c.k, {
      name: c.name, liveCount: ids.length, viewers: ids.reduce((s, id) => s + (counts.get(id) ?? 0), 0),
      thumbnailUrl: top ? hlsUrl(top, 'thumb.jpg') : null,
    });
  }
  // Popular recently, even if nobody is live in them right now.
  const recent = await query<{ k: string; name: string }>(`
    SELECT lower(category) AS k, min(category) AS name FROM broadcasts
     WHERE category <> '' AND started_at > now() - interval '30 days' AND ($1::text IS NULL OR category ILIKE $1)
     GROUP BY 1 ORDER BY count(*) DESC LIMIT 48`, [filter ? `%${likeEscape(filter)}%` : null]);
  for (const r of recent) if (!out.has(r.k)) out.set(r.k, { name: r.name, liveCount: 0, viewers: 0, thumbnailUrl: null });
  return [...out.values()]
    .sort((a, b) => b.viewers - a.viewers || b.liveCount - a.liveCount || a.name.localeCompare(b.name))
    .slice(0, 48);
}

export async function socialRoutes(app: FastifyInstance): Promise<void> {
  // ── follows ──
  const follow = (on: boolean) => async (req: FastifyRequest) => {
    const user = await requireUser(req);
    const { slug } = slugParams.parse(req.params);
    await rateLimit('follow', user.id, 60, 600);
    const ch = await channelBySlug(slug);
    if (!ch) throw notFound('Канал не найден');
    if (ch.id === user.channel_id) throw new HttpError(400, 'validation_failed', 'Нельзя подписаться на свой канал');
    const { changed, followers } = await tx(async (c) => {
      const res = on
        ? await c.query('INSERT INTO follows (user_id, channel_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [user.id, ch.id])
        : await c.query('DELETE FROM follows WHERE user_id = $1 AND channel_id = $2', [user.id, ch.id]);
      const delta = (res.rowCount ?? 0) * (on ? 1 : -1);
      const row = await one<{ followers_count: number }>(
        'UPDATE channels SET followers_count = followers_count + $2 WHERE id = $1 RETURNING followers_count', [ch.id, delta], c);
      return { changed: delta !== 0, followers: row!.followers_count };
    });
    if (on && changed) {
      // One alert per follower per day: follow/unfollow toggling can't spam the overlay.
      const fresh = redis.status === 'ready'
        ? await redis.set(keys.followAlertOnce(ch.id, user.id), '1', 'EX', 86_400, 'NX').catch(() => 'OK')
        : 'OK';
      if (fresh === 'OK') await publishOverlayAlert(ch.id, { type: 'follow', displayName: user.display_name, at: new Date().toISOString() });
    }
    return { following: on, followers };
  };
  app.post('/api/channels/:slug/follow', follow(true));
  app.delete('/api/channels/:slug/follow', follow(false));

  app.get('/api/me/following', async (req, reply) => {
    const user = await requireUser(req);
    reply.header('cache-control', 'no-store');
    const rows = await query<ChannelRow>(`
      SELECT ${CHANNEL_COLS} FROM follows f JOIN channels c ON c.id = f.channel_id JOIN users u ON u.id = c.owner_id
       WHERE f.user_id = $1 ORDER BY f.created_at DESC LIMIT 500`, [user.id]);
    const live = await liveByChannel(rows.map((r) => r.id));
    return {
      channels: rows
        .map((r) => ({ channel: channelPublic(r), live: live.get(r.id) ?? null }))
        .sort((a, b) => (b.live ? 1 : 0) - (a.live ? 1 : 0) || (b.live?.viewers ?? 0) - (a.live?.viewers ?? 0)),
    };
  });

  // ── categories & search ──
  app.get('/api/categories', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=5');
    return { categories: await categories() };
  });

  app.get('/api/search', async (req) => {
    const { q } = searchQuery.parse(req.query);
    await rateLimit('search', req.ip, 120, 60);
    const pattern = `%${likeEscape(q)}%`;
    const rows = await query<ChannelRow & { score: number }>(`
      SELECT ${CHANNEL_COLS},
             greatest(similarity(c.slug::text, $2), similarity(u.display_name, $2), similarity(c.title, $2)) AS score
        FROM channels c JOIN users u ON u.id = c.owner_id
       WHERE c.slug::text ILIKE $1 OR u.display_name ILIKE $1 OR c.title ILIKE $1
       ORDER BY score DESC, c.followers_count DESC LIMIT 40`, [pattern, q]);
    const live = await liveByChannel(rows.map((r) => r.id));
    const channels = rows
      .map((r) => ({ channel: channelPublic(r), live: live.get(r.id) ?? null }))
      .sort((a, b) => (b.live ? 1 : 0) - (a.live ? 1 : 0))
      .slice(0, 20);
    return { channels, categories: (await categories(q)).slice(0, 10) };
  });
}
