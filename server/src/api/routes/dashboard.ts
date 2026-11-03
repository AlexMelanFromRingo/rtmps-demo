import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.ts';
import { newStreamKey } from '../../lib/crypto.ts';
import { one, query, tx } from '../../lib/db.ts';
import { publishChannelEvent } from '../../lib/events.ts';
import { rateLimit } from '../ratelimit.ts';
import { requireUser } from '../session.ts';
import { activeBroadcast, channelById, channelPublic, liveInfo, viewerCounts } from '../views.ts';

const patchBody = z.object({
  title: z.string().trim().max(140).optional(),
  category: z.string().trim().max(40).optional(),
  transcodeMode: z.enum(['abr', 'passthrough']).optional(),
}).strict();

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

async function channelSettings(channelId: string) {
  const ch = (await channelById(channelId))!;
  const s = (await one<{ stream_key: string; transcode_mode: 'abr' | 'passthrough' }>(
    'SELECT stream_key, transcode_mode FROM channels WHERE id = $1', [channelId]))!;
  return { ch, ...s };
}

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/dashboard', async (req, reply) => {
    const user = await requireUser(req);
    reply.header('cache-control', 'no-store');
    const { ch, stream_key, transcode_mode } = await channelSettings(user.channel_id);

    const b = await activeBroadcast(user.channel_id);
    let live = null;
    if (b) {
      const viewers = (await viewerCounts([b.id])).get(b.id) ?? 0;
      const job = await one<{ state: 'pending' | 'running' | 'failed'; worker_id: string | null; last_error: string | null; stats: { fps?: number; speed?: number; encoder?: string; degraded?: boolean } | null }>(
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
      channel: { ...channelPublic(ch), transcodeMode: transcode_mode },
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
                       transcode_mode = COALESCE($4, transcode_mode), updated_at = now() WHERE id = $1`,
      [user.channel_id, body.title ?? null, body.category ?? null, body.transcodeMode ?? null]);
      // Like Twitch: changing the title mid-stream updates the live broadcast.
      await c.query(`UPDATE broadcasts SET title = COALESCE($2, title), category = COALESCE($3, category)
                      WHERE channel_id = $1 AND status <> 'ended'`, [user.channel_id, body.title ?? null, body.category ?? null]);
    });
    await publishChannelEvent(user.channel_id, { kind: 'state' });
    const { ch, transcode_mode } = await channelSettings(user.channel_id);
    return { channel: { ...channelPublic(ch), transcodeMode: transcode_mode } };
  });

  app.post('/api/channel/stream-key', async (req) => {
    const user = await requireUser(req);
    await rateLimit('key-reset', user.id, 10, 3600);
    const streamKey = newStreamKey();
    await query('UPDATE channels SET stream_key = $2, updated_at = now() WHERE id = $1', [user.channel_id, streamKey]);
    return { streamKey };
  });
}
