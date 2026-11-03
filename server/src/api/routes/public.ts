import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.ts';
import { notFound } from '../../lib/errors.ts';
import { keys, redis } from '../../lib/redis.ts';
import { log } from '../../lib/log.ts';
import { rateLimit } from '../ratelimit.ts';
import { currentUser } from '../session.ts';
import { one } from '../../lib/db.ts';
import { hub } from '../sse.ts';
import {
  activeBroadcast, channelBySlug, channelPublic, directory, lastBroadcast, liveInfoForChannel,
} from '../views.ts';

const slugParams = z.object({ slug: z.string().min(1).max(25) });
const heartbeatBody = z.object({ viewerId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/) });

// slug → active broadcast id, cached briefly (heartbeats are the hottest path).
const activeCache = new Map<string, { id: string | null; at: number }>();
async function activeBroadcastIdForSlug(slug: string): Promise<string | null | undefined> {
  const hit = activeCache.get(slug);
  if (hit && Date.now() - hit.at < 5000) return hit.id;
  const ch = await channelBySlug(slug);
  if (!ch) return undefined;
  const b = await activeBroadcast(ch.id);
  if (activeCache.size > 10_000) activeCache.clear();
  activeCache.set(slug, { id: b?.id ?? null, at: Date.now() });
  return b?.id ?? null;
}

export async function publicRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/streams', async (req, reply) => {
    const { category } = z.object({ category: z.string().trim().min(1).max(40).optional() }).parse(req.query);
    reply.header('cache-control', 'public, max-age=2');
    return { streams: await directory({ category }) };
  });

  app.get('/api/channels/:slug', async (req) => {
    const { slug } = slugParams.parse(req.params);
    const ch = await channelBySlug(slug);
    if (!ch) throw notFound('Канал не найден');
    const [live, last, viewer] = await Promise.all([liveInfoForChannel(ch.id), lastBroadcast(ch.id), currentUser(req)]);
    const following = viewer
      ? (await one('SELECT 1 FROM follows WHERE user_id = $1 AND channel_id = $2', [viewer.id, ch.id])) !== null
      : null;
    return { channel: channelPublic(ch), live, lastBroadcast: last, viewer: viewer ? { following } : null };
  });

  app.get('/api/channels/:slug/events', async (req, reply) => {
    const { slug } = slugParams.parse(req.params);
    const ch = await channelBySlug(slug);
    if (!ch) throw notFound('Канал не найден');
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    req.raw.on('close', () => hub.remove(ch.id, res));
    await hub.add(ch.id, res);
  });

  app.post('/api/channels/:slug/heartbeat', async (req, reply) => {
    const { slug } = slugParams.parse(req.params);
    const { viewerId } = heartbeatBody.parse(req.body);
    await rateLimit('hb', req.ip, 240, 60);
    const broadcastId = await activeBroadcastIdForSlug(slug.toLowerCase());
    if (broadcastId === undefined) throw notFound('Канал не найден');
    if (broadcastId && redis.status === 'ready') {
      const key = keys.viewers(broadcastId);
      await redis.multi().zadd(key, Date.now(), viewerId).expire(key, config.control.viewerTtlSec * 3).exec()
        .catch((err: Error) => log.warn({ err: err.message }, 'heartbeat write failed'));
    }
    return reply.status(204).send();
  });
}
