// Multistream destinations (restream to Twitch / YouTube / Kick / any RTMP(S)/SRT server).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.ts';
import { one, query } from '../../lib/db.ts';
import { validateDestinationUrl } from '../../lib/egress.ts';
import { HttpError, notFound } from '../../lib/errors.ts';
import { seal } from '../../lib/secretbox.ts';
import { requireUser } from '../session.ts';

export const RESTREAM_PURPOSE = 'restream';

type Row = {
  id: string; name: string; service: string; url: string; key_hint: string; enabled: boolean; transcode: string;
};

const view = (r: Row) => ({
  id: r.id, name: r.name, service: r.service, url: r.url, keyMasked: `••••${r.key_hint}`,
  enabled: r.enabled, transcode: r.transcode,
});

const url = z.string().trim().max(300).superRefine((v, ctx) => {
  const err = validateDestinationUrl(v);
  if (err) ctx.addIssue({ code: 'custom', message: err });
});
const base = {
  name: z.string().trim().min(1).max(40),
  service: z.enum(['twitch', 'youtube', 'kick', 'custom']),
  url,
  enabled: z.boolean(),
  transcode: z.enum(['auto', 'copy', 'h264']),
};
const createBody = z.object({
  ...base, streamKey: z.string().trim().min(1).max(300), enabled: base.enabled.default(true), transcode: base.transcode.default('auto'),
}).strict();
const patchBody = z.object({
  name: base.name.optional(), service: base.service.optional(), url: url.optional(), enabled: base.enabled.optional(),
  transcode: base.transcode.optional(), streamKey: z.string().trim().max(300).optional(),
}).strict();
const idParams = z.object({ id: z.uuid() });

const COLS = 'id, name, service, url, key_hint, enabled, transcode';

export async function restreamRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/channel/restreams', async (req, reply) => {
    const user = await requireUser(req);
    reply.header('cache-control', 'no-store');
    const rows = await query<Row>(`SELECT ${COLS} FROM restream_destinations WHERE channel_id = $1 ORDER BY created_at`, [user.channel_id]);
    return { destinations: rows.map(view) };
  });

  app.post('/api/channel/restreams', async (req, reply) => {
    const user = await requireUser(req);
    const b = createBody.parse(req.body);
    const count = await one<{ n: number }>('SELECT count(*)::int AS n FROM restream_destinations WHERE channel_id = $1', [user.channel_id]);
    if ((count?.n ?? 0) >= config.worker.restreamMax) {
      throw new HttpError(409, 'conflict', `Не больше ${config.worker.restreamMax} направлений`);
    }
    const row = await one<Row>(`
      INSERT INTO restream_destinations (channel_id, name, service, url, stream_key_enc, key_hint, enabled, transcode)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLS}`,
    [user.channel_id, b.name, b.service, b.url, seal(b.streamKey, RESTREAM_PURPOSE), b.streamKey.slice(-4), b.enabled, b.transcode]);
    return reply.status(201).send({ destination: view(row!) });
  });

  app.patch('/api/channel/restreams/:id', async (req) => {
    const user = await requireUser(req);
    const { id } = idParams.parse(req.params);
    const b = patchBody.parse(req.body);
    const key = b.streamKey ? b.streamKey : null; // empty = keep the current key
    const row = await one<Row>(`
      UPDATE restream_destinations SET
        name = COALESCE($3, name), service = COALESCE($4, service), url = COALESCE($5, url),
        enabled = COALESCE($6, enabled), transcode = COALESCE($7, transcode),
        stream_key_enc = COALESCE($8, stream_key_enc), key_hint = COALESCE($9, key_hint), updated_at = now()
      WHERE id = $1 AND channel_id = $2 RETURNING ${COLS}`,
    [id, user.channel_id, b.name ?? null, b.service ?? null, b.url ?? null, b.enabled ?? null, b.transcode ?? null,
      key ? seal(key, RESTREAM_PURPOSE) : null, key ? key.slice(-4) : null]);
    if (!row) throw notFound('Направление не найдено');
    return { destination: view(row) };
  });

  app.delete('/api/channel/restreams/:id', async (req, reply) => {
    const user = await requireUser(req);
    const { id } = idParams.parse(req.params);
    const rows = await query('DELETE FROM restream_destinations WHERE id = $1 AND channel_id = $2 RETURNING 1', [id, user.channel_id]);
    if (rows.length === 0) throw notFound('Направление не найдено');
    return reply.status(204).send();
  });
}
