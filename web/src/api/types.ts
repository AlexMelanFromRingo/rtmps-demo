// Types mirror docs/API.md exactly. Keep in sync with the contract.

export type User = {
  id: string;
  username: string;
  displayName: string;
  createdAt: string;
  /** v2 */
  twoFactorEnabled: boolean;
};

export type ChannelLink = { label: string; url: string };

export type ChannelPublic = {
  slug: string;
  displayName: string;
  title: string;
  category: string;
  // v2:
  /** /media/avatars/…; null → monogram */
  avatarUrl: string | null;
  /** up to 300 chars */
  bio: string;
  /** up to 5, https:// only */
  links: ChannelLink[];
  followers: number;
  /** 18+: viewers confirm before watching */
  mature: boolean;
};

export type Protocol = 'rtmp' | 'srt' | 'webrtc' | 'rtsp' | 'unknown';

export type SourceInfo = {
  protocol: Protocol;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
};

export type RenditionCodec = 'H264' | 'H265' | 'AV1';

export type Rendition = {
  name: string;
  label: string;
  codec: RenditionCodec;
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
  passthrough: boolean;
};

export type LiveStatus = 'live' | 'reconnecting';

export type LiveInfo = {
  broadcastId: string;
  status: LiveStatus;
  startedAt: string;
  viewers: number;
  playbackUrl: string | null;
  thumbnailUrl: string | null;
  source: SourceInfo;
  renditions: Rendition[];
  /** v2: `low` = 1 s segments, aggressive player sync. */
  latencyMode: LatencyMode;
};

export type LatencyMode = 'normal' | 'low';

export type StreamCard = { channel: ChannelPublic; live: LiveInfo };

export type StreamsResponse = { streams: StreamCard[] };

export type LastBroadcast = { title: string; startedAt: string; endedAt: string };

export type ChannelViewer = { following: boolean };

export type ChannelResponse = {
  channel: ChannelPublic;
  live: LiveInfo | null;
  lastBroadcast: LastBroadcast | null;
  /** v2: null for anonymous visitors. */
  viewer: ChannelViewer | null;
};

/** SSE `state` event. `channel` carries live title/category edits (optional for forward compat). */
export type ChannelStateEvent = { live: LiveInfo | null; channel?: ChannelPublic };

export type AuthUserResponse = { user: User };

export type MeResponse = { user: User; channel: ChannelPublic };

export type TranscodeMode = 'abr' | 'passthrough';

export type ChannelPrivate = ChannelPublic & {
  transcodeMode: TranscodeMode;
  // v2:
  saveVods: boolean;
  lowLatency: boolean;
  /** Relative path `/overlay/<token>`. */
  overlayUrl: string;
};

export type TranscoderStats = {
  state: 'pending' | 'running' | 'failed';
  worker: string | null;
  encoder: string | null;
  fps: number | null;
  speed: number | null;
  /** No free full-transcoding capacity: source only (+ H.264 ≤480p). */
  degraded?: boolean;
  /** Why the transcode is not running (shown to the streamer). */
  error?: string | null;
};

export type LiveStats = {
  ingestKbps: number | null;
  ingestNode: string | null;
  transcoder: TranscoderStats | null;
  /** v2: one per enabled restream destination. */
  restreams: RestreamStatus[];
};

export type DashboardLive = LiveInfo & { stats: LiveStats };

export type IngestInfo = {
  rtmp: { server: string; streamKey: string; codecs: string[] };
  srt: { url: string; codecs: string[] };
  /** Universal SRT gateway: any container FFmpeg reads (AV1 in Matroska/WebM…). */
  srtAny?: { url: string; codecs: string[]; containers: string[] };
  whip: { url: string; codecs: string[] };
};

export type RecentBroadcast = {
  id: string;
  title: string;
  category: string;
  startedAt: string;
  endedAt: string | null;
  peakViewers: number;
  protocol: Protocol | string;
  videoCodec: string | null;
  width: number | null;
  height: number | null;
};

export type DashboardResponse = {
  channel: ChannelPrivate;
  streamKey: string;
  ingest: IngestInfo;
  live: DashboardLive | null;
  recent: RecentBroadcast[];
};

export type ChannelPatch = {
  title?: string;
  category?: string;
  transcodeMode?: TranscodeMode;
  // v2:
  bio?: string;
  links?: ChannelLink[];
  mature?: boolean;
  saveVods?: boolean;
  lowLatency?: boolean;
};

export type ChannelPatchResponse = { channel: ChannelPrivate };

export type StreamKeyResponse = { streamKey: string };

export type ApiErrorBody = { error: { code: string; message: string } };

// ---------------------------------------------------------------- v2

export type ChannelWithLive = { channel: ChannelPublic; live: LiveInfo | null };

export type FollowResponse = { following: boolean; followers: number };

export type FollowingResponse = { channels: ChannelWithLive[] };

export type Category = {
  name: string;
  liveCount: number;
  viewers: number;
  thumbnailUrl: string | null;
};

export type CategoriesResponse = { categories: Category[] };

export type SearchResponse = { channels: ChannelWithLive[]; categories: Category[] };

/** A recorded past broadcast (VOD). `id` == broadcastId. */
export type Video = {
  id: string;
  channel: ChannelPublic;
  title: string;
  category: string;
  startedAt: string;
  endedAt: string;
  durationSec: number;
  thumbnailUrl: string | null;
  /** VOD master.m3u8 (EXT-X-ENDLIST, seekable). */
  playbackUrl: string;
  views: number;
  /** When the recording will be deleted. */
  expiresAt: string;
  renditions: Rendition[];
};

export type VideosResponse = { videos: Video[] };

export type VideoResponse = { video: Video };

export type RestreamService = 'twitch' | 'youtube' | 'kick' | 'custom';

export type RestreamTranscode = 'auto' | 'copy' | 'h264';

export type RestreamDestination = {
  id: string;
  name: string;
  service: RestreamService;
  /** rtmp:// | rtmps:// | srt:// (without the key) */
  url: string;
  /** "••••••3f9a" — the full key is never returned. */
  keyMasked: string;
  enabled: boolean;
  transcode: RestreamTranscode;
};

export type RestreamStatus = {
  /** == destination id */
  id: string;
  state: 'connecting' | 'live' | 'error';
  error: string | null;
  since: string;
};

export type RestreamsResponse = { destinations: RestreamDestination[] };

export type RestreamDestinationResponse = { destination: RestreamDestination };

export type RestreamCreate = {
  name: string;
  service: RestreamService;
  url: string;
  streamKey: string;
  enabled?: boolean;
  transcode?: RestreamTranscode;
};

/** Any POST field; an empty `streamKey` keeps the current key. */
export type RestreamPatch = Partial<RestreamCreate>;

export type OverlayResetResponse = { overlayUrl: string };

export type OverlayAlertEvent = { type: 'follow'; displayName: string; at: string };

export type OverlayStatsEvent = { live: boolean; viewers: number };

export type AvatarContentType = 'image/png' | 'image/jpeg' | 'image/webp';

export type AvatarResponse = { avatarUrl: string };

export type HealthSample = { ts: string; viewers: number; ingestKbps: number | null };

export type HealthResponse = { samples: HealthSample[] };

export type Session = {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  userAgent: string;
  ip: string;
  current: boolean;
};

export type SessionsResponse = { sessions: Session[] };

export type TwoFactorStatus = { enabled: boolean };

export type TwoFactorSetup = { secret: string; otpauthUrl: string };

export type TwoFactorEnableResponse = { recoveryCodes: string[] };

export type LoginBody = { username: string; password: string; totp?: string };
