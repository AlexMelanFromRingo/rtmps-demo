// Types mirror docs/API.md exactly. Keep in sync with the contract.

export type User = {
  id: string;
  username: string;
  displayName: string;
  createdAt: string;
};

export type ChannelPublic = {
  slug: string;
  displayName: string;
  title: string;
  category: string;
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
};

export type StreamCard = { channel: ChannelPublic; live: LiveInfo };

export type StreamsResponse = { streams: StreamCard[] };

export type LastBroadcast = { title: string; startedAt: string; endedAt: string };

export type ChannelResponse = {
  channel: ChannelPublic;
  live: LiveInfo | null;
  lastBroadcast: LastBroadcast | null;
};

/** SSE `state` event. `channel` carries live title/category edits (optional for forward compat). */
export type ChannelStateEvent = { live: LiveInfo | null; channel?: ChannelPublic };

export type AuthUserResponse = { user: User };

export type MeResponse = { user: User; channel: ChannelPublic };

export type TranscodeMode = 'abr' | 'passthrough';

export type ChannelPrivate = ChannelPublic & { transcodeMode: TranscodeMode };

export type TranscoderStats = {
  state: 'pending' | 'running';
  worker: string | null;
  encoder: string | null;
  fps: number | null;
  speed: number | null;
};

export type LiveStats = {
  ingestKbps: number | null;
  ingestNode: string | null;
  transcoder: TranscoderStats | null;
};

export type DashboardLive = LiveInfo & { stats: LiveStats };

export type IngestInfo = {
  rtmp: { server: string; streamKey: string; codecs: string[] };
  srt: { url: string; codecs: string[] };
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
};

export type ChannelPatchResponse = { channel: ChannelPrivate };

export type StreamKeyResponse = { streamKey: string };

export type ApiErrorBody = { error: { code: string; message: string } };
