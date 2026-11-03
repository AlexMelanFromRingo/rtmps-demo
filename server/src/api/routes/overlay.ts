// OBS browser-source overlay: secret-URL SSE feed + studio controls.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one } from '../../lib/db.ts';
import { notFound } from '../../lib/errors.ts';
import { publishOverlayAlert } from '../../lib/events.ts';
import { overlayHub } from '../overlay.ts';
import { rateLimit } from '../ratelimit.ts';
import { requireUser } from '../session.ts';

export const overlayPath = (token: string) => `/overlay/${token}`;

export async function overlayRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/overlay/:token/events', async (req, reply) => {
    const { token } = z.object({ token: z.string().regex(/^[0-9a-f]{64}$/) }).parse(req.params);
    await rateLimit('overlay', req.ip, 60, 60);
    const ch = await one<{ id: string }>('SELECT id::text FROM channels WHERE overlay_token = $1', [token]);
    if (!ch) throw notFound('Оверлей не найден');
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    req.raw.on('close', () => overlayHub.remove(ch.id, res));
    await overlayHub.add(ch.id, res);
  });

  app.post('/api/channel/overlay/test', async (req, reply) => {
    const user = await requireUser(req);
    await rateLimit('overlay-test', user.id, 20, 60);
    await publishOverlayAlert(user.channel_id, { type: 'follow', displayName: 'Тестовый зритель', at: new Date().toISOString(), test: true });
    return reply.status(204).send();
  });

  app.post('/api/channel/overlay/reset', async (req) => {
    const user = await requireUser(req);
    const row = await one<{ overlay_token: string }>(`
      UPDATE channels SET overlay_token = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
       WHERE id = $1 RETURNING overlay_token`, [user.channel_id]);
    overlayHub.disconnect(user.channel_id); // the old URL stops working right away
    return { overlayUrl: overlayPath(row!.overlay_token) };
  });
}
