import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.ts';
import { newStreamKey } from '../../lib/crypto.ts';
import { one, query, tx } from '../../lib/db.ts';
import { publishChannelEvent } from '../../lib/events.ts';
import { rateLimit } from '../ratelimit.ts';
import { requireUser } from '../session.ts';
import { overlayPath } from './overlay.ts';
import { HttpError, notFound } from '../../lib/errors.ts';
import { randomString } from '../../lib/crypto.ts';
import { deleteObject, putObject } from '../../lib/s3.ts';
import { mediaUrl } from '../views.ts';
import { activeBroadcast, channelById, channelPublic, liveInfo, viewerCounts } from '../views.ts';

const link = z.object({
  label: z.string().trim().min(1).max(30),
  url: z.url().max(200).refine((u) => u.startsWith('https://'), 'Ссылки — только https://'),
});
const patchBody = z.object({
  title: z.string().trim().max(140).optional(),
  category: z.string().trim().max(40).optional(),
  transcodeMode: z.enum(['abr', 'passthrough']).optional(),
  bio: z.string().trim().max(300).optional(),
  links: z.array(link).max(5).optional(),
  mature: z.boolean().optional(),
  saveVods: z.boolean().optional(),
  lowLatency: z.boolean().optional(),
}).strict();

const AVATAR_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const;
const avatarBody = z.object({
  contentType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  data: z.string().max(2_800_000), // base64 of ≤ 2 MiB
});

/** Magic-byte check: the declared type must match the actual file. */
export function sniffImage(buf: Buffer): keyof typeof AVATAR_TYPES | null {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export function ingestUrls(streamKey: string) {
  const path = `live/${streamKey}`;
  return {
    rtmp: { server: config.public.rtmpUrl, streamKey, codecs: ['H264', 'H265', 'AV1', 'VP9'] },
    srt: { url: `${config.public.srtUrl}?streamid=publish:${path}&pkt_size=1316`, codecs: ['H264', 'H265'] },
    // Any container FFmpeg can read (Matroska/WebM, FLV, MPEG-TS…), remuxed without re-encoding.
    srtAny: {
      url: `${config.public.srtAnyUrl}?streamid=publish:${path}`,
      codecs: ['AV1', 'VP9', 'VP8', 'H265', 'H264'],
      containers: ['Matroska/WebM', 'FLV', 'MPEG-TS'],
    },
    whip: { url: `${config.public.whipUrl}/${path}/whip`, codecs: ['H264', 'H265', 'AV1', 'VP9', 'VP8'] },
  };
}

type Settings = {
  stream_key: string; transcode_mode: 'abr' | 'passthrough'; save_vods: boolean; low_latency: boolean; overlay_token: string;
};

async function channelSettings(channelId: string) {
  const ch = (await channelById(channelId))!;
  const s = (await one<Settings>(
    'SELECT stream_key, transcode_mode, save_vods, low_latency, overlay_token FROM channels WHERE id = $1', [channelId]))!;
  return { ch, ...s };
}

function privateChannel(ch: Awaited<ReturnType<typeof channelSettings>>) {
  return {
    ...channelPublic(ch.ch),
    transcodeMode: ch.transcode_mode,
    saveVods: ch.save_vods,
    lowLatency: ch.low_latency,
    overlayUrl: overlayPath(ch.overlay_token),
  };
}

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/dashboard', async (req, reply) => {
    const user = await requireUser(req);
    reply.header('cache-control', 'no-store');
    const settings = await channelSettings(user.channel_id);
    const { stream_key } = settings;

    const b = await activeBroadcast(user.channel_id);
    let live = null;
    if (b) {
      const viewers = (await viewerCounts([b.id])).get(b.id) ?? 0;
      const job = await one<{ state: 'pending' | 'running' | 'failed'; worker_id: string | null; last_error: string | null; stats: { fps?: number; speed?: number; encoder?: string; degraded?: boolean; restreams?: unknown[] } | null }>(
        `SELECT state, worker_id, stats, CASE WHEN attempts > 1 OR state = 'pending' THEN last_error END AS last_error
           FROM transcode_jobs WHERE broadcast_id = $1 AND state IN ('pending', 'running')
          UNION ALL
         SELECT state, worker_id, stats, last_error FROM transcode_jobs
          WHERE broadcast_id = $1 AND state = 'failed'
            AND NOT EXISTS (SELECT 1 FROM transcode_jobs WHERE broadcast_id = $1 AND state IN ('pending', 'running'))
          LIMIT 1`, [b.id]);
      live = {
        ...liveInfo(b, viewers),
        stats: {
          ingestKbps: b.ingest_kbps,
          ingestNode: b.ingest_node,
          restreams: job?.state === 'running' ? (job.stats?.restreams ?? []) : [],
          transcoder: job ? {
            state: job.state,
            worker: job.worker_id,
            encoder: job.stats?.encoder ?? null,
            fps: job.stats?.fps ?? null,
            speed: job.stats?.speed ?? null,
            degraded: job.stats?.degraded ?? false,
            // Why the transcode is not running (after a failed attempt), for the streamer.
            error: job.state === 'running' && job.stats ? null : (job.last_error ?? null),
          } : null,
        },
      };
    }

    const recent = await query<{ id: string; title: string; category: string; started_at: Date; ended_at: Date | null; peak_viewers: number; protocol: string | null; video_codec: string | null; width: number | null; height: number | null }>(
      `SELECT id, title, category, started_at, ended_at, peak_viewers, protocol, video_codec, width, height
         FROM broadcasts WHERE channel_id = $1 ORDER BY started_at DESC LIMIT 10`, [user.channel_id]);

    return {
      channel: privateChannel(settings),
      streamKey: stream_key,
      ingest: ingestUrls(stream_key),
      live,
      recent: recent.map((r) => ({
        id: r.id, title: r.title, category: r.category,
        startedAt: new Date(r.started_at).toISOString(), endedAt: r.ended_at ? new Date(r.ended_at).toISOString() : null,
        peakViewers: r.peak_viewers, protocol: r.protocol, videoCodec: r.video_codec, width: r.width, height: r.height,
      })),
    };
  });

  app.patch('/api/channel', async (req) => {
    const user = await requireUser(req);
    const body = patchBody.parse(req.body);
    await tx(async (c) => {
      await c.query(`UPDATE channels SET title = COALESCE($2, title), category = COALESCE($3, category),
                       transcode_mode = COALESCE($4, transcode_mode), bio = COALESCE($5, bio), links = COALESCE($6, links),
                       mature = COALESCE($7, mature), save_vods = COALESCE($8, save_vods), low_latency = COALESCE($9, low_latency),
                       updated_at = now() WHERE id = $1`,
      [user.channel_id, body.title ?? null, body.category ?? null, body.transcodeMode ?? null, body.bio ?? null,
        body.links ? JSON.stringify(body.links) : null, body.mature ?? null, body.saveVods ?? null, body.lowLatency ?? null]);
      // Like Twitch: changing the title mid-stream updates the live broadcast.
      await c.query(`UPDATE broadcasts SET title = COALESCE($2, title), category = COALESCE($3, category)
                      WHERE channel_id = $1 AND status <> 'ended'`, [user.channel_id, body.title ?? null, body.category ?? null]);
    });
    await publishChannelEvent(user.channel_id, { kind: 'state' });
    return { channel: privateChannel(await channelSettings(user.channel_id)) };
  });

  app.post('/api/channel/stream-key', async (req) => {
    const user = await requireUser(req);
    await rateLimit('key-reset', user.id, 10, 3600);
    const streamKey = newStreamKey();
    await query('UPDATE channels SET stream_key = $2, updated_at = now() WHERE id = $1', [user.channel_id, streamKey]);
    return { streamKey };
  });

  // ── avatar (stored in object storage, served by the edge under /media) ──
  app.post('/api/channel/avatar', { bodyLimit: 3 * 1024 * 1024 }, async (req) => {
    const user = await requireUser(req);
    await rateLimit('avatar', user.id, 20, 3600);
    const body = avatarBody.parse(req.body);
    const buf = Buffer.from(body.data, 'base64');
    if (buf.length === 0) throw new HttpError(400, 'validation_failed', 'Пустой файл');
    if (buf.length > 2 * 1024 * 1024) throw new HttpError(413, 'payload_too_large', 'Аватар больше 2 МБ');
    const actual = sniffImage(buf);
    if (actual !== body.contentType) throw new HttpError(400, 'validation_failed', 'Файл не является PNG, JPEG или WebP');
    // Random key per upload: the URL is immutable and cacheable forever.
    const key = `avatars/${user.channel_id}/${randomString(16)}.${AVATAR_TYPES[actual]}`;
    await putObject(key, buf, actual, 'public, max-age=31536000, immutable');
    const prev = await one<{ avatar_key: string | null }>(
      'UPDATE channels SET avatar_key = $2 WHERE id = $1 RETURNING old.avatar_key', // PostgreSQL 18 OLD row
      [user.channel_id, key]);
    if (prev?.avatar_key) await deleteObject(prev.avatar_key).catch(() => {});
    await publishChannelEvent(user.channel_id, { kind: 'state' });
    return { avatarUrl: mediaUrl(key) };
  });

  app.delete('/api/channel/avatar', async (req, reply) => {
    const user = await requireUser(req);
    const prev = await one<{ avatar_key: string | null }>(
      'UPDATE channels SET avatar_key = NULL WHERE id = $1 RETURNING old.avatar_key',
      [user.channel_id]);
    if (prev?.avatar_key) await deleteObject(prev.avatar_key).catch(() => {});
    await publishChannelEvent(user.channel_id, { kind: 'state' });
    return reply.status(204).send();
  });

  // ── stream health graphs (Twitch "Stream Manager" / OBS stats style) ──
  app.get('/api/dashboard/health', async (req, reply) => {
    const user = await requireUser(req);
    const { broadcastId } = z.object({ broadcastId: z.uuid().optional() }).parse(req.query);
    reply.header('cache-control', 'no-store');
    const b = await one<{ id: string }>(broadcastId
      ? 'SELECT id FROM broadcasts WHERE id = $1 AND channel_id = $2'
      : 'SELECT id FROM broadcasts WHERE channel_id = $2 AND ($1::uuid IS NULL) ORDER BY started_at DESC LIMIT 1',
    [broadcastId ?? null, user.channel_id]);
    if (!b) {
      if (broadcastId) throw notFound('Эфир не найден');
      return { broadcastId: null, samples: [] };
    }
    const rows = await query<{ ts: Date; viewers: number; ingest_kbps: number | null }>(
      'SELECT ts, viewers, ingest_kbps FROM broadcast_samples WHERE broadcast_id = $1 ORDER BY ts LIMIT 5000', [b.id]);
    return {
      broadcastId: b.id,
      samples: rows.map((r) => ({ ts: new Date(r.ts).toISOString(), viewers: r.viewers, ingestKbps: r.ingest_kbps })),
    };
  });
}
