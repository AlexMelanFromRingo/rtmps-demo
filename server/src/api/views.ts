// Read models: DB rows → API shapes (see docs/API.md).
import { config } from '../config.ts';
import { one, query } from '../lib/db.ts';
import { keys, redis } from '../lib/redis.ts';

export type ChannelLink = { label: string; url: string };

export type ChannelPublic = {
  slug: string; displayName: string; title: string; category: string;
  avatarUrl: string | null; bio: string; links: ChannelLink[]; followers: number; mature: boolean;
};

export type Rendition = {
  name: string; label: string; codec: string; width: number; height: number; fps: number; bitrateKbps: number; passthrough: boolean;
};

export type LiveInfo = {
  broadcastId: string;
  status: 'live' | 'reconnecting';
  startedAt: string;
  viewers: number;
  playbackUrl: string | null;
  thumbnailUrl: string | null;
  source: { protocol: string; videoCodec: string | null; audioCodec: string | null; width: number | null; height: number | null; fps: number | null };
  renditions: Rendition[];
  latencyMode: 'normal' | 'low';
};

export type BroadcastRow = {
  id: string; channel_id: string; status: 'live' | 'reconnecting'; started_at: Date; ready_at: Date | null;
  protocol: string | null; video_codec: string | null; audio_codec: string | null;
  width: number | null; height: number | null; fps: number | null; renditions: Rendition[];
  ingest_kbps: number | null; ingest_node: string | null; latency_mode: 'normal' | 'low';
};

export type ChannelRow = {
  id: string; slug: string; display_name: string; title: string; category: string;
  avatar_key: string | null; bio: string; links: ChannelLink[]; followers_count: number; mature: boolean;
};

export const BROADCAST_COLS = `b.id, b.channel_id::text, b.status, b.started_at, b.ready_at, b.protocol, b.video_codec, b.audio_codec,
  b.width, b.height, b.fps, b.renditions, b.ingest_kbps, b.ingest_node, b.latency_mode`;

export const CHANNEL_COLS = `c.id::text, c.slug::text, u.display_name, c.title, c.category,
  c.avatar_key, c.bio, c.links, c.followers_count, c.mature`;

export const hlsUrl = (broadcastId: string, file: string) => `${config.public.hlsBase}/live/${broadcastId}/${file}`;
export const mediaUrl = (key: string) => `${config.public.mediaBase}/${key}`;

export function channelPublic(c: ChannelRow): ChannelPublic {
  return {
    slug: c.slug, displayName: c.display_name, title: c.title, category: c.category,
    avatarUrl: c.avatar_key ? mediaUrl(c.avatar_key) : null,
    bio: c.bio, links: c.links ?? [], followers: c.followers_count, mature: c.mature,
  };
}

export async function viewerCounts(ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (ids.length === 0 || redis.status !== 'ready') return out;
  try {
    const vals = await redis.hmget(keys.viewerCount, ...ids);
    ids.forEach((id, i) => out.set(id, Number(vals[i] ?? 0) || 0));
  } catch { /* degrade to 0 viewers */ }
  return out;
}

export function liveInfo(b: BroadcastRow, viewers: number): LiveInfo {
  const ready = b.ready_at !== null;
  return {
    broadcastId: b.id,
    status: b.status,
    startedAt: new Date(b.started_at).toISOString(),
    viewers,
    playbackUrl: ready ? hlsUrl(b.id, 'master.m3u8') : null,
    thumbnailUrl: ready ? hlsUrl(b.id, 'thumb.jpg') : null,
    source: {
      protocol: b.protocol ?? 'unknown',
      videoCodec: b.video_codec,
      audioCodec: b.audio_codec,
      width: b.width,
      height: b.height,
      fps: b.fps === null ? null : Math.round(b.fps * 100) / 100,
    },
    renditions: ready ? b.renditions : [],
    latencyMode: b.latency_mode ?? 'normal',
  };
}

export async function channelBySlug(slug: string): Promise<ChannelRow | null> {
  return one<ChannelRow>(`SELECT ${CHANNEL_COLS} FROM channels c JOIN users u ON u.id = c.owner_id WHERE c.slug = $1`, [slug]);
}

export async function channelById(id: string): Promise<ChannelRow | null> {
  return one<ChannelRow>(`SELECT ${CHANNEL_COLS} FROM channels c JOIN users u ON u.id = c.owner_id WHERE c.id = $1`, [id]);
}

export async function activeBroadcast(channelId: string): Promise<BroadcastRow | null> {
  return one<BroadcastRow>(`SELECT ${BROADCAST_COLS} FROM broadcasts b WHERE b.channel_id = $1 AND b.status <> 'ended'`, [channelId]);
}

export async function liveInfoForChannel(channelId: string): Promise<LiveInfo | null> {
  const b = await activeBroadcast(channelId);
  if (!b) return null;
  const v = await viewerCounts([b.id]);
  return liveInfo(b, v.get(b.id) ?? 0);
}

export async function lastBroadcast(channelId: string) {
  const r = await one<{ title: string; started_at: Date; ended_at: Date }>(
    `SELECT title, started_at, ended_at FROM broadcasts WHERE channel_id = $1 AND status = 'ended' ORDER BY started_at DESC LIMIT 1`, [channelId]);
  return r ? { title: r.title, startedAt: new Date(r.started_at).toISOString(), endedAt: new Date(r.ended_at).toISOString() } : null;
}

/** Live channels for a set of channel ids (used by follows / search). */
export async function liveByChannel(channelIds: string[]): Promise<Map<string, LiveInfo>> {
  const out = new Map<string, LiveInfo>();
  if (channelIds.length === 0) return out;
  const rows = await query<BroadcastRow>(`SELECT ${BROADCAST_COLS} FROM broadcasts b
    WHERE b.channel_id = ANY($1::bigint[]) AND b.status <> 'ended'`, [channelIds]);
  const counts = await viewerCounts(rows.map((r) => r.id));
  for (const r of rows) out.set(r.channel_id, liveInfo(r, counts.get(r.id) ?? 0));
  return out;
}

export async function directory(opts: { category?: string | undefined } = {}): Promise<{ channel: ChannelPublic; live: LiveInfo }[]> {
  const rows = await query<BroadcastRow & ChannelRow & { id: string }>(`
    SELECT ${BROADCAST_COLS}, ${CHANNEL_COLS.replace('c.id::text,', '')}
      FROM broadcasts b JOIN channels c ON c.id = b.channel_id JOIN users u ON u.id = c.owner_id
     WHERE b.status <> 'ended'
       -- A stream that never produced video (unsupported codec, broken encoder)
       -- is shown to its owner in the studio, not to viewers in the directory.
       AND (b.ready_at IS NOT NULL OR b.started_at > now() - interval '60 seconds')
       AND ($1::text IS NULL OR lower(b.category) = lower($1))
     ORDER BY b.started_at DESC LIMIT 500`, [opts.category ?? null]);
  const counts = await viewerCounts(rows.map((r) => r.id));
  return rows
    .map((r) => ({ channel: channelPublic(r), live: liveInfo(r, counts.get(r.id) ?? 0) }))
    .sort((a, b) => b.live.viewers - a.live.viewers);
}
